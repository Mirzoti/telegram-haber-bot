require('dotenv').config();
const { Telegraf } = require('telegraf');
const WPAPI = require('wpapi');
const axios = require('axios'); // Telegram'dan görseli indirip WP'ye aktarmak için
const { GoogleGenAI } = require('@google/genai');

// -- Çevresel değişkenleri yükle --
const {
    BOT_TOKEN,
    AUTHORIZED_CHAT_ID,
    WP_ENDPOINT,
    WP_USERNAME,
    WP_APP_PASSWORD
} = process.env;

// Telegraf botunu başlat
const bot = new Telegraf(BOT_TOKEN);

// WordPress API istemcisini başlat
const wp = new WPAPI({
    endpoint: WP_ENDPOINT,
    username: WP_USERNAME,
    password: WP_APP_PASSWORD
});

// Yetki kontrolü için Chat ID'leri diziye çeviriyoruz (Birden çok kullanıcı destekler)
const allowedChatIds = AUTHORIZED_CHAT_ID.split(',').map(id => parseInt(id.trim(), 10));

// -- State Management (Basit Bellek İçi Durum Yönetimi) --
// Kullanıcıların fotoğraf yükleyip metin beklediği durumu burada tutuyoruz.
// Yapı: { [chatId]: { step: 'WAITING_FOR_TEXT', photoUrl: '...' } }
const userStates = {};

// GÜVENLİK ADIMI: Middleware ile gelen isteği filtrele
bot.use((ctx, next) => {
    // Mesajın gönderildiği Chat ID listemizdeki ID'lerden biriyse işleme devam et
    if (ctx.chat && allowedChatIds.includes(ctx.chat.id)) {
        return next();
    }
    // Eşleşmiyorsa konsola bilgi yaz, kullanıcıyı görmezden gel veya uyar
    console.log(`Yetkisiz erişim denemesi tespit edildi. ID: ${ctx.chat?.id}`);
});

bot.start((ctx) => {
    ctx.reply('👋 Merhaba! WordPress Haber Botu aktif.\nLütfen önce haberde kullanmak istediğiniz **fotoğrafı** gönderin.');
});

// ADIM 1: Fotoğraf Geldiğinde
bot.on('photo', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        
        // Telegram fotoğrafı farklı çözünürlüklerde (dizi olarak) gönderir. En yüksek kalite sonuncusudur.
        const photoArray = ctx.message.photo;
        const highestResPhoto = photoArray[photoArray.length - 1];
        
        // Fotoğrafın Telegram sunucularındaki direkt indirme bağlantısını alalım
        const fileLink = await ctx.telegram.getFileLink(highestResPhoto.file_id);
        
        // Kullanıcının state'ini (durumunu) kaydet
        userStates[chatId] = {
            step: 'WAITING_FOR_TEXT',
            photoUrl: fileLink.href
        };
        
        ctx.reply('✅ Fotoğrafı aldım! Şimdi lütfen haber atın.\n\n*(Not: Attığınız mesajın ilk satırı "Başlık", alt satırları ise "Haber Uzun Metni" olarak algılanacaktır)*');
    } catch (error) {
        console.error('Fotoğraf kaydedilirken hata:', error);
        ctx.reply('❌ Fotoğraf alınırken bir hata oluştu. Lütfen tekrar gönderin.');
    }
});

// ADIM 2 & 3: Metin Geldiğinde (WordPress'e Yükleme Aşaması)
bot.on('text', async (ctx) => {
    const chatId = ctx.chat.id;
    const userState = userStates[chatId];
    
    // Kullanıcı bir resim gönderdiyse ve sistem metin bekliyorsa
    if (userState && userState.step === 'WAITING_FOR_TEXT') {
        const fullText = ctx.message.text;
        
        // Metni satırlara böl
        const lines = fullText.split('\n');
        
        // İlk satır: BAŞLIK, geri kalan satırlar: İÇERİK
        const title = lines[0];
        const content = lines.slice(1).join('\n').trim();
        
        if (!title || !content) {
            return ctx.reply('⚠️ Lütfen mesajınızı kontrol edin. En az 2 satır olmalı (1. Satır: Başlık, Diğerleri: İçerik).');
        }

        ctx.reply('⏳ Fotoğraf medya kütüphanesine yükleniyor ve haberiniz yayınlanıyor. Lütfen bekleyin...');

        try {
            // A) Telegram'daki fotoğrafı indir (ArrayBuffer formatında)
            const imageResponse = await axios.get(userState.photoUrl, { responseType: 'arraybuffer' });
            const imageBuffer = Buffer.from(imageResponse.data, 'binary');
            
            // B) WordPress Medya'sına Yükle
            const fileName = `haber_foto_${Date.now()}.jpg`;
            const mediaUpload = await wp.media()
                .file(imageBuffer, fileName)
                .create({
                    title: title + ' - Öne Çıkan Görsel',
                    alt_text: title
                });
                
            const featuredImageId = mediaUpload.id;

            let generatedTags = [];
            if (process.env.GEMINI_API_KEY) {
                try {
                    ctx.reply("🤖 Metin okunuyor, yapay zeka SEO etiketlerini üretiyor...");
                    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
                    const prompt = `Sen profesyonel bir gazeteci ve SEO uzmanısın. Aşağıdaki haber metninden, Google aramalarında en çok tıklanmayı sağlayacak, konuyu en iyi özetleyen 5 anahtar kelimeyi (etiketi) çıkar.
                    Kurallar:
                    1. Sadece kelimelerin arasına virgül koy. (Örn: Haber, Ekonomi, İzmir, Yatırım, Proje)
                    2. Başka tek bir cümle bile yazma. Madde imi, sayı, giriş cümlesi vs. KESİNLİKLE OLMASIN.
                    3. Her kelimenin ilk harfi mutlaka büyük olsun.
                    
                    Haber Başlığı: ${title}
                    Haber Metni: ${content}`;

                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: prompt
                    });

                    const aiTags = response.text.split(',').map(t => t.trim()).filter(t => t.length > 0);
                    ctx.reply(`🧠 Yapay zekanın bulduğu SEO etiketleri: ${aiTags.join(', ')}\nSisteme entegre ediliyor...`);

                    for (const tag of aiTags) {
                        try {
                            const searchRes = await wp.tags().param('search', tag);
                            if (searchRes && searchRes.length > 0) {
                                generatedTags.push(searchRes[0].id);
                            } else {
                                const created = await wp.tags().create({ name: tag });
                                generatedTags.push(created.id);
                            }
                        } catch (e) { } // Hatalari atla
                    }
                } catch (aiErr) {
                    console.error("Yapay Zeka Hatasi:", aiErr);
                    ctx.reply("⚠️ Yapay zeka sunucusuna erişimde hata. Habere etiketsiz devam ediliyor...");
                }
            }

            // Haberin hem öne çıkan görseli olsun hem de metnin en üstünde (yazı içinde) görünsün
            const imageHtml = `<figure class="wp-block-image size-large"><img src="${mediaUpload.source_url}" alt="${title}" style="max-width: 100%; height: auto;" /></figure>\n\n`;
            const contentWithImage = imageHtml + content;

            // C) Yazıyı (Post) Oluştur
            const postPayload = {
                title: title,
                content: contentWithImage,
                status: 'publish', // Hemen yayına girmesi için 'publish'. Taslak için 'draft' yapabilirsiniz.
                featured_media: featuredImageId // Yüklediğimiz fotoğrafı Öne Çıkan Görsel yaptık
            };
            if (generatedTags.length > 0) {
                postPayload.tags = generatedTags;
            }

            const newPost = await wp.posts().create(postPayload);

            // Adım 4: İşlem başarılı!
            ctx.reply(`🎉 Haber başarıyla yayınlandı!\n\n🔗 Link: ${newPost.link}`);
            
            // Kullanıcının bellek durumunu sıfırla ki yeni haberler atabilsin
            delete userStates[chatId];
            
        } catch (error) {
            console.error('WP Yükleme Hatası:', error);
            // wpapi kaynaklı hatalar error.message içinde detaylandırılabilir
            ctx.reply(`❌ İçerik WordPress'e yüklenirken hata oluştu!\nHata detayı: ${error.message || 'Bilinmeyen Hata'}`);
        }
    } else {
        // Kullanıcı bota rastgele bir metin yazarsa
        ctx.reply('⚠️ Haber yayınlamak için önce bana bir **fotoğraf** göndermeniz gerekiyor.');
    }
});

// Botu çalıştır
bot.launch().then(() => {
    console.log('🤖 Haber Botu başarıyla çalıştırıldı ve mesaj bekliyor...');
});

// Sunucu çökmesi veya botun manuel sonlandırılması gibi durumlarda botu güvenlice kapat
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ==========================================
// RENDER.COM 7/24 ÇALIŞMA (WEB SERVİSİ) İÇİN
// ==========================================
// Render.com ücretsiz sürümde (Web Service) bir PORT dinlenmesini bekler,
// aksi takdirde uygulamanın çöktüğünü sanıp kapatır.
const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Haber Botu 7/24 Aktif Olarak Calisiyor!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Render Web Servisi ${PORT} portunda dinleniyor...`);
});
