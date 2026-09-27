// Har tarah ki canvas, DOMMatrix aur pdfjs warnings ko process level par silent karein
process.env.SUPPRESS_SUPPORT_WARNINGS = "1";
process.env.NODE_NO_WARNINGS = "1";

const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('DOMMatrix') ||
     args[0].includes('Path2D') ||
     args[0].includes('fetchStandardFontData') ||
     args[0].includes('Canvas'))
  ) {
    return;
  }
  originalWarn(...args);
};

const rateLimit = require('express-rate-limit');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const { evaluate } = require('mathjs');
const { translate } = require('@vitalets/google-translate-api');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const adminModule = require('firebase-admin');
require('dotenv').config();

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const admin = adminModule.default || adminModule;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// ----------------------------------------------------
// 1. FIREBASE ADMIN SDK INITIALIZATION
// ----------------------------------------------------
let db = null;
try {
  const serviceAccount = require('./serviceAccountKey.json');
  if (admin && admin.credential) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase Admin SDK Connected Successfully!");
    db = admin.firestore();
  }
} catch (fbError) {
  console.warn("⚠️ Firebase bypass (No DB mode):", fbError.message);
}

const app = express();
const PORT = process.env.PORT || 5500;

// Render proxy ke through aane wale client IP ko correctly read karne ke liye
app.set('trust proxy', 1);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ----------------------------------------------------
// RATE LIMITER CONFIGURATION (API Abuse Protection)
// ----------------------------------------------------
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute ka window
  max: 30, // Har IP ko 15 minute me max 30 requests allow karega
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    reply: "⚠️ **Limit Reached:** Aapne 15 minute ki request limit cross kar di hai. Kripya thodi der baad prayas karein.",
    timestamp: new Date().toISOString()
  }
});

// Chat aur Voice endpoints dono par limiter apply karein
app.use('/api/chat', chatLimiter);
app.use('/api/voice-chat', chatLimiter);

// ----------------------------------------------------
// 2. SMART SYSTEM PROMPT (LANGUAGE, IDENTITY & TYPO HANDLING)
// ----------------------------------------------------
function getLiveDateContext(userLocation = null) {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'medium'
  }).format(now);

  const cityName = userLocation?.city || 'Agra';

  return `[System Context: Current Time: ${dateStr}, User Location:${cityName}, India.]\n` +
         `Identity & Ownership Rules:\n` +
         `- Aapka naam "RakeshAi" hai.\n` +
         `- Jab sawaal specific ho ki "tumhara malik kaun hai", "tumhe kisne banaya", ya "who is your owner/creator", tab spasht batayein ki aapke malik aur nirmata "Rakesh Shukla" hain.\n` +
         `- DHYAN RAHE: Agar kisi doosri company ya vyakti ke malik ke baare me poocha jaye (jaise Google, Microsoft, Apple, Tesla, Twitter, Tata, Reliance), toh Rakesh Shukla ka naam KABHI MAT LEIN. Us company ke asali owner/founders (jaise Google ke Larry Page, Sergey Brin aur parent company Alphabet) ka sachha jawab dein.\n\n` +
         `Universal Spelling & Typo Tolerance:\n` +
         `- User ki query me spelling mistakes, typos ya galat shabdon ko ignore karein aur sentence ke context se asal matlab samjhein. (Example: "jahreela saaf" ka matlab "jahreela saanp", "femous" ka matlab "famous", "kanha" ka matlab "kahan"). Galat literal arth nikaal kar off-topic jawab na dein.\n\n` +
         `Strict Language Rules:\n` +
         `- Agar user Hindi me ya Romanized Hinglish me sawal pooche (e.g. "google ka malik kaun hai", "tum kaise ho", "aaj ka mausam kaisa hai"), toh aapko hamesha HINDI (Devanagari Lipi - हिंदी) me hi spasht jawab dena hai.\n` +
         `- Agar user English me pooche, toh English me jawab dein.\n` +
         `- Agar user kisi doosri bhasha me pooche (Tamil, Telugu, Gujarati, Bengali, etc.), toh usi bhasha me jawab dein.\n\n` +
         `Tone & Formatting:\n` +
         `- Jawab seedha, saaf, bina faltu bhed-bhav ke, point-to-point dein.\n` +
         `- Code blocks me programming language tag zaroor likhein (e.g. \`\`\`python).\n\n`;
}

// ----------------------------------------------------
// 3. EXTENDED LANGUAGE DICTIONARY
// ----------------------------------------------------
const languageMap = {
  'tamil': { code: 'ta', name: 'Tamil' },
  'telugu': { code: 'te', name: 'Telugu' },
  'hindi': { code: 'hi', name: 'Hindi' },
  'english': { code: 'en', name: 'English' },
  'gujarati': { code: 'gu', name: 'Gujarati' },
  'gujrati': { code: 'gu', name: 'Gujarati' },
  'gujrai': { code: 'gu', name: 'Gujarati' },
  'sanskrit': { code: 'sa', name: 'Sanskrit' },
  'marathi': { code: 'mr', name: 'Marathi' },
  'bengali': { code: 'bn', name: 'Bengali' },
  'bangla': { code: 'bn', name: 'Bengali' },
  'punjabi': { code: 'pa', name: 'Punjabi' },
  'urdu': { code: 'ur', name: 'Urdu' },
  'kannada': { code: 'kn', name: 'Kannada' },
  'malayalam': { code: 'ml', name: 'Malayalam' },
  'odia': { code: 'or', name: 'Odia' },
  'french': { code: 'fr', name: 'French' },
  'german': { code: 'de', name: 'German' },
  'spanish': { code: 'es', name: 'Spanish' },
  'russian': { code: 'ru', name: 'Russian' },
  'japanese': { code: 'ja', name: 'Japanese' },
  'arabic': { code: 'ar', name: 'Arabic' }
};

// ----------------------------------------------------
// 4. ACCURATE INTENT CLASSIFICATION
// ----------------------------------------------------
function detectUserIntent(text) {
  const q = text.toLowerCase().trim();

  // A. AI ka Apna Malik / Creator Check (Sirf RakeshAi ke liye)
  const isAboutAI = /\b(tumhara|tumhe|aapka|aapko|your|tera|ye ai|is ai)\b/i.test(q) ||
                    q === 'malik kaun hai' || q === 'owner kaun hai' || q === 'who is your owner';
  const hasOwnerWord = /\b(malik|maalik|owner|creator|nirmata|banaya)\b/i.test(q);
  const otherEntities = ['google', 'microsoft', 'apple', 'tesla', 'meta', 'facebook', 'tata', 'reliance', 'amazon', 'twitter', 'x'];
  const hasOtherEntity = otherEntities.some(e => q.includes(e));

  if (isAboutAI && hasOwnerWord && !hasOtherEntity) {
    return 'BOT_OWNER_QUERY';
  }

  // B. Translation Intent Check (Strict)
  const isExplicitTranslate = /\b(translate|anuvad|meaning of|arth)\b/i.test(q);
  const isLanguageAtEnd = Object.keys(languageMap).some(l => {
    const endRegex = new RegExp(`\\b(in|into|to)\\s+${l}\\b$`, 'i');
    return endRegex.test(q);
  });
  const isConversational = /\b(batao|samjhao|likho|kaun|kya|kaise|karo|kaun ho|tum kaun)\b/i.test(q);

  if ((isExplicitTranslate || isLanguageAtEnd) && !isConversational) {
    const matchedLang = Object.keys(languageMap).some(l => new RegExp(`\\b${l}\\b`, 'i').test(q));
    if (matchedLang) {
      return 'TRANSLATION';
    }
  }

  // C. Weather Intent
  const weatherWords = ['weather', 'mausam', 'tapman', 'temperature', 'humidity', 'barish', 'aaj barish hogi'];
  if (weatherWords.some(w => q.includes(w))) {
    return 'WEATHER';
  }

  // D. Local Places & Attractions Intent
  const placeTerms = [
    'aas paas', 'aas-paas', 'aas pas', 'aas paak', 'nearby', 'near me',
    'paas me', 'famous jagah', 'ghoomne', 'ghumne', 'places to visit',
    'tourist spot', 'famous food', 'femous khana', 'famous khana', 'famous market',
    'famous temple', 'mandir', 'best jagah', 'ghumne ki'
  ];
  if (placeTerms.some(t => q.includes(t)) || ((q.includes('famous') || q.includes('femous') || q.includes('ghoom')) && (q.includes('kya hai') || q.includes('batao') || q.includes('best') || q.includes('kanha')))) {
    return 'NEARBY_PLACES';
  }

  // E. Greetings
  const greetings = ['hello', 'hi', 'hey', 'namaste', 'pranam', 'kaise ho', 'how are you', 'kya haal hai', 'who are you', 'kaun ho'];
  const cleanWord = q.replace(/[?,.!]/g, '');
  if (greetings.some(g => cleanWord === g || cleanWord.startsWith(g + ' ') || cleanWord.endsWith(' ' + g))) {
    return 'GREETING';
  }

  // F. BODMAS Math
  const isMathWords = /(divided\s+by|devied\s+by|divide\s+by|bhaag|multiplied\s+by|into|guna|plus|add|minus|subtract|\+|\-|\*|\/|\^)/i.test(q);
  if (/\d/.test(q) && isMathWords && !q.includes('pincode') && !q.includes('ifsc') && !q.includes('date')) {
    return 'MATH';
  }

  // G. Bank IFSC
  if (/\b[A-Z]{4}0[A-Z0-9]{6}\b/i.test(q)) {
    return 'IFSC';
  }

  // H. Pincode
  if (/\b\d{6}\b/.test(q) || q.includes('pincode') || q.includes('pin code')) {
    return 'PINCODE';
  }

  // I. Wikipedia Query
  if (q.includes('kya hai') || q.includes('what is') || q.includes('who is') || q.includes('meaning of')) {
    return 'WIKI';
  }

  // J. Live Web Search
  if (q.includes('last date') || q.includes('sarkari') || q.includes('yojana') || q.includes('score') || q.includes('match') || q.includes('kab aayega')) {
    return 'WEB_SEARCH';
  }

  return 'AI_FALLBACK';
}

function getBotOwnerResponse() {
  return "🚀 **राकेश शुक्ला (Rakesh Shukla)** हमारे मालिक और निर्माता हैं। उन्होंने ही मुझे (RakeshAi) डिज़ाइन और डेवलप किया है।";
}

// ----------------------------------------------------
// 5. LOCAL GUIDE ENGINE (GEOAPIFY + STRICT 15KM RADIUS)
// ----------------------------------------------------
async function handleNearbyPlaces(query, userLocation) {
  const geoKey = process.env.GEOAPIFY_API_KEY?.trim();
  const q = query.toLowerCase();

  let lat = userLocation?.lat || 27.1767;
  let lon = userLocation?.lon || 78.0081;
  let cityName = userLocation?.city || 'Agra';

  const commonCities = [
    'lucknow', 'delhi', 'agra', 'kanpur', 'varanasi', 'gonda', 'bareilly',
    'ayodhya', 'prayagraj', 'noida', 'jaipur', 'mathura', 'meerut'
  ];
  const foundCity = commonCities.find(c => q.includes(c));
  if (foundCity) {
    cityName = foundCity.charAt(0).toUpperCase() + foundCity.slice(1);
  }

  let categories = 'tourism.attraction,tourism.sights,heritage';
  let categoryLabel = "🏛️ आस-पास घूमने की प्रसिद्ध जगहें";

  if (q.includes('food') || q.includes('khana') || q.includes('restaurant') || q.includes('sweet') || q.includes('chai')) {
    categories = 'catering.restaurant,catering.fast_food,catering.cafe';
    categoryLabel = "🍲 प्रसिद्ध खाना और लोकप्रिय फ़ूड स्पॉट्स";
  } else if (q.includes('market') || q.includes('bazar') || q.includes('shopping') || q.includes('mall')) {
    categories = 'commercial.shopping_mall,commercial.marketplace';
    categoryLabel = "🛍️ प्रसिद्ध बाज़ार और शॉपिंग स्थल";
  } else if (q.includes('temple') || q.includes('mandir')) {
    categories = 'building.place_of_worship';
    categoryLabel = "🛕 प्रसिद्ध मंदिर और धार्मिक स्थल";
  }

  let placesData = [];
  if (geoKey) {
    try {
      const url = `https://api.geoapify.com/v2/places?categories=${categories}&filter=circle:${lon},${lat},15000&bias=proximity:${lon},${lat}&limit=6&apiKey=${geoKey}`;
      const res = await axios.get(url, { timeout: 6000 });
      if (res.data?.features && res.data.features.length > 0) {
        placesData = res.data.features.map(f => ({
          name: f.properties.name || f.properties.street || 'Famous Landmark',
          address: f.properties.formatted || f.properties.city || '',
          distance: f.properties.distance ? `${(f.properties.distance / 1000).toFixed(1)} km` : 'Nearby'
        })).filter(p => p.name !== 'Famous Landmark');
      }
    } catch (e) {
      console.warn("⚠️ Geoapify Warning:", e.message);
    }
  }

  const placesPrompt = `User Query: "${query}"\n` +
    `Exact Target City: ${cityName}\n` +
    `Live Geoapify GPS Landmarks (within 15km): ${JSON.stringify(placesData)}\n\n` +
    `Strict Directives:\n` +
    `1. ONLY provide recommendations situated in ${cityName} and within 10-15 km.\n` +
    `2. Jawab shuddh aur saral Hindi (हिंदी) me dein.\n` +
    `3. 4-5 pramukh sthano ki suchi dein, sath me 1 line me unki khasiyat aur visiting tip likhein.\n` +
    `4. Agar khana poocha gaya hai, toh ${cityName} ke mashhoor swadist vyanjan batayein.`;

  try {
    const aiReply = await executeSmartAIRoute(placesPrompt, [], null, userLocation);
    return `## ${categoryLabel} — **${cityName}**\n\n` + aiReply;
  } catch (err) {
    let out = `## ${categoryLabel} — **${cityName}**\n\n`;
    placesData.slice(0, 5).forEach((p, idx) => {
      out += `### ${idx + 1}. **${p.name}**\n- 📍 **पता:** ${p.address}\n- 📏 **दूरी:** ${p.distance}\n\n`;
    });
    return out;
  }
}

// ----------------------------------------------------
// 6. TRANSLATION ENGINE WITH PHONETIC PRONUNCIATION
// ----------------------------------------------------
async function handleTranslationWithPronunciation(query) {
  const q = query.toLowerCase();
  let targetLang = { code: 'en', name: 'English' };

  for (const [key, val] of Object.entries(languageMap)) {
    const langRegex = new RegExp(`\\b${key}\\b`, 'i');
    if (langRegex.test(q)) {
      targetLang = val;
      break;
    }
  }

  const cleanRegex = new RegExp(
    `\\b(translate|in|to|into|me|mein|ko|ka|anuvad|karo|batao)\\b|\\b(${Object.keys(languageMap).join('|')})\\b|[?"']`,
    'gi'
  );
  let textToTranslate = query.replace(cleanRegex, ' ').replace(/\s+/g, ' ').trim();
  if (textToTranslate.length < 2) return null;

  try {
    const res = await translate(textToTranslate, { to: targetLang.code });
    const translatedText = res.text;

    let pronunciation = '';
    if (res.raw && Array.isArray(res.raw)) {
      try {
        const r = res.raw;
        if (r[0] && r[0][1] && r[0][1][2]) pronunciation = r[0][1][2];
        else if (r[0] && r[0][1] && r[0][1][3]) pronunciation = r[0][1][3];
      } catch (e) {}
    }

    if (!pronunciation || pronunciation.toLowerCase().trim() === translatedText.toLowerCase().trim()) {
      try {
        const prompt = `Give ONLY the phonetic pronunciation (uchcharan in Latin/English alphabets) for this ${targetLang.name} text: "${translatedText}". Return nothing else.`;
        const aiPronounce = await callGroq(prompt);
        if (aiPronounce) pronunciation = aiPronounce.replace(/["']/g, '').trim();
      } catch (err) {}
    }

    let pronunciationDisplay = '';
    if (pronunciation && pronunciation.toLowerCase().trim() !== translatedText.toLowerCase().trim()) {
      pronunciationDisplay = `\n> 🗣️ **Pronunciation (Uchcharan):** *(${pronunciation})*\n`;
    }

    return `### 🌐 Translation (${targetLang.name}):\n\n` +
           `- **Original Text:** "${textToTranslate}"\n` +
           `- **${targetLang.name}:** **${translatedText}**\n` +
           pronunciationDisplay;
  } catch (err) {
    return null;
  }
}

// ----------------------------------------------------
// 7. ZERO-TOKEN FAST UTILITIES
// ----------------------------------------------------
const quickGreetings = {
  'hello': "👋 **नमस्ते!** मैं **RakeshAi** हूँ। मैं आपकी क्या मदद कर सकता हूँ?",
  'hi': "👋 **नमस्ते!** मैं **RakeshAi** हूँ। कहिए, आज क्या जानकारी चाहिए?",
  'kaise ho': "मैं बिल्कुल ठीक हूँ! 😊 आप बताइए, आज किस विषय में सहायता चाहिए?",
  'kaun ho': "🤖 मैं **RakeshAi** हूँ — राकेश शुक्ला द्वारा निर्मित आपका पर्सनल स्मार्ट असिस्टेंट।"
};

function getGreetingResponse(query) {
  const clean = query.toLowerCase().replace(/[?,.!]/g, '').trim();
  for (const [key, val] of Object.entries(quickGreetings)) {
    if (clean === key || clean.startsWith(key + ' ') || clean.endsWith(' ' + key)) {
      return val;
    }
  }
  return "👋 **नमस्ते!** मैं RakeshAi हूँ, बताइए मैं आपकी क्या सहायता करूँ?";
}

function evaluateMathExpression(query) {
  let q = query.toLowerCase().trim();
  q = q.replace(/(is\s+)?(divided\s+by|devied\s+by|divide\s+by|bhaag)/g, '/')
       .replace(/(multiplied\s+by|multiply\s+by|into|guna|times)/g, '*')
       .replace(/(plus|add|jodo)/g, '+')
       .replace(/(minus|subtract|ghatao)/g, '-')
       .replace(/kya\s+hoga|kya\s+hai|equals|answer|\?/g, '')
       .trim();

  try {
    const result = evaluate(q);
    const formatted = typeof result === 'number' ? Number(result.toFixed(6)).toString() : result.toString();
    return `### 🧮 गणितीय गणना (Math Calculation):\n\n> समीकरण: \`${q}\`\n\n**उत्तर = \`${formatted}\`**`;
  } catch (err) {
    return null;
  }
}

async function getIFSCDetails(query) {
  const match = query.toUpperCase().match(/\b[A-Z]{4}0[A-Z0-9]{6}\b/);
  if (!match) return null;

  try {
    const res = await axios.get(`https://ifsc.razorpay.com/${match[0]}`, { timeout: 4000 });
    const b = res.data;
    return `### 🏦 बैंक एवं शाखा विवरण:\n\n` +
           `- **बैंक का नाम:** ${b.BANK}\n` +
           `- **शाखा (Branch):** ${b.BRANCH}\n` +
           `- **पता:** ${b.ADDRESS}\n` +
           `- **शहर:** ${b.CITY}\n` +
           `- **राज्य:** ${b.STATE}\n` +
           `- **IFSC कोड:** \`${b.IFSC}\`\n` +
           `- **IMPS / UPI:** समर्थित ✅`;
  } catch (err) {
    return `⚠️ IFSC कोड \`${match[0]}\` सत्यापित नहीं हो सका।`;
  }
}

async function getPincodeDetails(query) {
  const digitMatch = query.match(/\b\d{6}\b/);
  if (digitMatch) {
    const pin = digitMatch[0];
    try {
      const res = await axios.get(`https://api.postalpincode.in/pincode/${pin}`, { timeout: 5000 });
      if (res.data && res.data[0].Status === "Success" && res.data[0].PostOffice) {
        const off = res.data[0].PostOffice[0];
        return `### 📮 पिनकोड जानकारी: \`${pin}\`\n\n` +
               `- **डाकघर (Post Office):** ${off.Name}\n` +
               `- **जिला (District):** ${off.District}\n` +
               `- **राज्य (State):** ${off.State}\n\n` +
               `> क्षेत्र: **${off.District}, ${off.State}**`;
      }
    } catch (e) {}
  }
  return null;
}

async function getWeather(query, userCity = null) {
  let city = userCity || 'Agra';
  const words = query.replace(/[?,.!]/g, '').split(' ');
  const ignore = ['weather', 'mausam', 'ka', 'aaj', 'today', 'in', 'of', 'kaisa', 'hai', 'batao', 'what', 'is', 'the', 'now', 'live', 'bataiye', 'mere', 'aas', 'paas'];
  const found = words.find(w => !ignore.includes(w.toLowerCase()) && w.length > 2);
  if (found) city = found;

  try {
    const res = await axios.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { timeout: 5000 });
    const c = res.data.current_condition[0];
    const area = res.data.nearest_area[0].areaName[0].value;
    const country = res.data.nearest_area[0].country[0].value;

    return `## 🌤️ <u>**लाइव मौसम — ${area}, ${country}**</u>\n\n` +
           `| पैरामीटर | स्थिति |\n` +
           `| :--- | :--- |\n` +
           `| 🌦️ **स्थिति** | **${c.weatherDesc[0].value}** |\n` +
           `| 🌡️ **तापमान** | **${c.temp_C}°C** (${c.temp_F}°F) |\n` +
           `| 🌡️ **महसूस (Feels Like)** | **${c.FeelsLikeC}°C** |\n` +
           `| 💧 **नमी (Humidity)** | **${c.humidity}%** |\n` +
           `| 💨 **हवा की गति** | **${c.windspeedKmph} km/h** |\n\n`;
  } catch (e) {
    return null;
  }
}

async function getWikiSummary(query) {
  let clean = query.trim().replace(/(kya hai|what is|who is|meaning of|\?)/gi, '').trim();
  if (clean.length < 2) return null;

  try {
    const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(clean)}`, { timeout: 4000 });
    if (res.data?.extract && res.data.type !== 'disambiguation') {
      return `### 📚 **${res.data.title}**\n\n${res.data.extract}\n\n🔗 [Wikipedia Page](${res.data.content_urls.desktop.page})`;
    }
  } catch (err) {}
  return null;
}

async function getWebSearch(query) {
  try {
    const searchUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const res = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000
    });
    const xml = res.data;
    const matches = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g)];

    if (matches.length > 0) {
      let out = `## <u>ताज़ा अपडेट: <span style="color: #2563eb;">${query.toUpperCase()}</span></u>\n\n`;
      matches.slice(0, 4).forEach((m, i) => {
        out += `### ${i + 1}. ${m[1].replace(/<[^>]+>/g, '').trim()}\n[विस्तार से पढ़ें](${m[2].trim()})\n\n---\n`;
      });
      return out;
    }
  } catch (e) {}
  return null;
}

// ----------------------------------------------------
// 8. ATTACHMENT EXTRACTION ENGINE
// ----------------------------------------------------
async function extractTextFromPDF(buffer) {
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdfDoc = await loadingTask.promise;

  let fullText = '';
  const pagesToRead = Math.min(pdfDoc.numPages, 5);
  for (let pageNum = 1; pageNum <= pagesToRead; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    fullText += `\n[Page ${pageNum}]\n` + textContent.items.map(item => item.str).join(' ');
  }
  return fullText.trim();
}

async function processAttachment(attachment) {
  if (!attachment || !attachment.base64) return null;
  const { category, base64, mimeType, name } = attachment;
  const rawBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
  const buffer = Buffer.from(rawBase64, 'base64');
  const lowerName = (name || '').toLowerCase();

  if (category === 'image' || (mimeType && mimeType.startsWith('image/'))) {
    return { type: 'image', mimeType: mimeType || 'image/jpeg', data: rawBase64, name: name || 'image' };
  }

  if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
    try {
      let extracted = await extractTextFromPDF(buffer);
      if (extracted && extracted.length > 30) {
        return { type: 'text', content: `\n\n--- [Document: "${name}"] ---\n${extracted.substring(0, 5000)}\n--- [End] ---\n` };
      }
    } catch (e) {}
  }

  if (lowerName.endsWith('.docx')) {
    try {
      const res = await mammoth.extractRawText({ buffer });
      return { type: 'text', content: `\n\n--- [Document: "${name}"] ---\n${res.value.substring(0, 5000)}\n--- [End] ---\n` };
    } catch (e) {}
  }

  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.csv')) {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      let excelText = '';
      workbook.eachSheet((worksheet) => {
        excelText += `\n[Sheet: ${worksheet.name}]\n`;
        worksheet.eachRow((row) => {
          excelText += row.values.filter(Boolean).join(', ') + '\n';
        });
      });
      return { type: 'text', content: `\n\n--- [Attached Spreadsheet: "${name}"] ---\n${excelText.substring(0, 5000)}\n--- [End] ---\n` };
    } catch (e) {}
  }

  return null;
}

// ----------------------------------------------------
// 9. HIGH-PERFORMANCE MULTI-MODEL ADAPTERS
// ----------------------------------------------------
async function callGemini(prompt, history = [], processedMedia = null, userLocation = null) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const contents = [{ role: 'user', parts: [{ text: `${getLiveDateContext(userLocation)}${prompt}` }] }];
  if (processedMedia && processedMedia.type === 'image') {
    contents[0].parts.push({
      inline_data: { mime_type: processedMedia.mimeType, data: processedMedia.data }
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const response = await axios.post(
    url,
    { contents },
    { headers: { 'Content-Type': 'application/json' }, httpAgent, httpsAgent, timeout: 20000 }
  );
  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

async function callGroq(prompt, userLocation = null) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY missing");

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: `${getLiveDateContext(userLocation)}${prompt}` }],
      max_tokens: 1000
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      httpAgent,
      httpsAgent,
      timeout: 12000
    }
  );
  return response.data?.choices?.[0]?.message?.content;
}

async function executeSmartAIRoute(prompt, history = [], processedMedia = null, userLocation = null) {
  if (processedMedia && processedMedia.type === 'image') {
    return await callGemini(prompt, history, processedMedia, userLocation);
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const reply = await callGemini(prompt, history, processedMedia, userLocation);
      if (reply) return reply;
    } catch (err) {
      console.warn("⚠️ Gemini limit, switching to Groq...", err.response?.data?.error?.message || err.message);
    }
  }

  if (process.env.GROQ_API_KEY) {
    try {
      const reply = await callGroq(prompt, userLocation);
      if (reply) return reply;
    } catch (err) {}
  }

  return "इस समय AI नेटवर्क व्यस्त है। कृपया 5 सेकंड बाद पुनः प्रयास करें।";
}

// ----------------------------------------------------
// 10. VOICE-TO-TEXT TRANSCRIPTION (GROQ WHISPER)
// ----------------------------------------------------
async function transcribeAudio(audioBuffer) {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (!groqKey) throw new Error("Groq API Key missing for Whisper STT");

  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.webm', contentType: 'audio/webm' });
  form.append('model', 'whisper-large-v3');

  const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${groqKey}`
    },
    timeout: 15000
  });

  return res.data?.text || '';
}

// ----------------------------------------------------
// 11. SMART QUERY PROCESSING HIERARCHY
// ----------------------------------------------------
async function processUserQuery(userText, location, history = [], attachment = null) {
  let processedMedia = null;
  let finalPrompt = userText;

  if (attachment) {
    processedMedia = await processAttachment(attachment);
    if (processedMedia && processedMedia.type === 'text') {
      finalPrompt = `${userText}\n\n${processedMedia.content}`;
      processedMedia = null;
    }
  }

  const intent = attachment ? 'ATTACHMENT' : detectUserIntent(userText);
  console.log(`🎯 Identified Intent: [${intent}] for Query: "${userText}"`);

  let reply = null;

  // Level 1: Bot Identity
  if (intent === 'BOT_OWNER_QUERY') {
    reply = getBotOwnerResponse();
  }
  // Level 2: Fast Local & Zero-Token Handlers
  else if (intent === 'WEATHER') {
    reply = await getWeather(userText, location?.city);
  }
  else if (intent === 'NEARBY_PLACES') {
    reply = await handleNearbyPlaces(userText, location);
  }
  else if (intent === 'TRANSLATION') {
    reply = await handleTranslationWithPronunciation(userText);
  }
  else if (intent === 'GREETING') {
    reply = getGreetingResponse(userText);
  }
  else if (intent === 'MATH') {
    reply = evaluateMathExpression(userText);
  }
  else if (intent === 'IFSC') {
    reply = await getIFSCDetails(userText);
  }
  else if (intent === 'PINCODE') {
    reply = await getPincodeDetails(userText);
  }
  else if (intent === 'WIKI') {
    reply = await getWikiSummary(userText);
  }
  else if (intent === 'WEB_SEARCH') {
    reply = await getWebSearch(userText);
  }

  // Level 3: AI Cascade (Gemini -> Groq)
  if (!reply) {
    reply = await executeSmartAIRoute(finalPrompt, history, processedMedia, location);
  }

  return { reply, intent };
}

// ----------------------------------------------------
// 12. FIRESTORE DATABASE SAVER
// ----------------------------------------------------
async function saveMessageSmartly(userId, sessionId, role, text, intent, attachmentMeta = null) {
  if (!db || !userId || userId === 'guest_user' || userId.startsWith('guest_')) return;

  if (intent === 'GREETING' || (intent === 'MATH' && !attachmentMeta)) {
    return;
  }

  let chatTopic = 'New Conversation';
  if (role === 'user') {
    if (intent === 'WEATHER') chatTopic = `Mausam: ${text.substring(0, 25)}`;
    else if (intent === 'NEARBY_PLACES') chatTopic = `Explore: ${text.substring(0, 25)}`;
    else if (intent === 'TRANSLATION') chatTopic = `Translation: ${text.substring(0, 25)}`;
    else if (intent === 'PINCODE') chatTopic = `Pincode: ${text.substring(0, 20)}`;
    else chatTopic = text.length > 30 ? text.substring(0, 30) + '...' : text;
  }

  try {
    const sessionRef = db.collection('users').doc(userId).collection('sessions').doc(sessionId);

    await sessionRef.set({
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      preview: chatTopic,
      title: chatTopic
    }, { merge: true });

    await sessionRef.collection('messages').add({
      role: role,
      content: text,
      intent: intent,
      attachment: attachmentMeta,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {}
}

// ----------------------------------------------------
// 13. MASTER API ENDPOINTS (WITH STRICT AUTH GUARD)
// ----------------------------------------------------

// Text / Document Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, attachment, history = [], location = null, userId = null, sessionId = 'default' } = req.body;

    // STRICT AUTH GUARD: Bina valid Google login ke query process nahi hogi
    if (!userId || userId === 'guest_user' || userId === 'anonymous' || userId.startsWith('guest_')) {
      return res.status(401).json({
        reply: "⚠️ **Login Required:** Kripya pehle Google account se login karein. Bina login ke RakeshAi se sawal nahi pooch sakte.",
        timestamp: new Date().toISOString()
      });
    }

    if ((!message || !message.trim()) && !attachment) {
      return res.status(400).json({ error: 'Message ya attachment zaroori hai.' });
    }

    const userText = message ? message.trim() : 'कृपया इस दस्तावेज़ को समझाएं।';
    const attachmentMeta = attachment ? {
      name: attachment.name,
      category: attachment.category,
      mimeType: attachment.mimeType
    } : null;

    saveMessageSmartly(userId, sessionId, 'user', userText, 'PENDING', attachmentMeta);

    const { reply, intent } = await processUserQuery(userText, location, history, attachment);

    saveMessageSmartly(userId, sessionId, 'assistant', reply, intent);

    return res.json({
      reply,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("Server Error:", err.message);
    return res.json({
      reply: "अनुरोध प्रोसेस करते समय देरी हुई। कृपया दोबारा प्रयास करें।",
      timestamp: new Date().toISOString()
    });
  }
});

// Voice-to-Text Endpoint
app.post('/api/voice-chat', async (req, res) => {
  try {
    const { audioBase64, location = null, userId = null, sessionId = 'default', history = [] } = req.body;

    // STRICT AUTH GUARD for Voice
    if (!userId || userId === 'guest_user' || userId === 'anonymous' || userId.startsWith('guest_')) {
      return res.status(401).json({
        transcribedText: '',
        reply: "⚠️ **Login Required:** Voice feature use karne ke liye pehle Google account se login karein.",
        timestamp: new Date().toISOString()
      });
    }

    if (!audioBase64) {
      return res.status(400).json({ error: 'Audio data missing hai.' });
    }

    const rawBase64 = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
    const audioBuffer = Buffer.from(rawBase64, 'base64');

    const transcribedText = await transcribeAudio(audioBuffer);
    if (!transcribedText || !transcribedText.trim()) {
      return res.json({
        transcribedText: '',
        reply: "आपकी आवाज़ साफ सुनाई नहीं दी, कृपया दोबारा बोलें।"
      });
    }

    saveMessageSmartly(userId, sessionId, 'user', transcribedText, 'VOICE_INPUT');

    const { reply, intent } = await processUserQuery(transcribedText, location, history);

    saveMessageSmartly(userId, sessionId, 'assistant', reply, intent);

    return res.json({
      transcribedText,
      reply,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error("Voice Processing Error:", err.message);
    return res.json({
      transcribedText: '',
      reply: "Voice process करने में समस्या आई। कृपया लिखकर पूछें।"
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 RakeshAi Master Server running on port ${PORT}`);
});