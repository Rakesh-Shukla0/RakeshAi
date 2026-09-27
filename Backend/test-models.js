require('dotenv').config();
const axios = require('axios');

async function testRemaining() {
  console.log("=========================================");
  console.log("🔍 TESTING 4 REMAINING AI PROVIDERS");
  console.log("=========================================\n");

  // 1. OPENROUTER CHECK
  console.log("--- 1. Testing OpenRouter ---");
  try {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) throw new Error("OPENROUTER_API_KEY is missing in .env");

    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'Say "OpenRouter OK"' }]
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5500',
          'X-Title': 'RakeshAi'
        },
        timeout: 15000
      }
    );
    console.log("✅ OpenRouter Working! Reply:", res.data?.choices?.[0]?.message?.content?.trim());
  } catch (e) {
    console.log("❌ OpenRouter Error:", e.response?.data?.error?.message || e.response?.data || e.message);
  }

  // 2. MISTRAL AI CHECK (Models & Quota)
  console.log("\n--- 2. Testing Mistral AI ---");
  try {
    const key = process.env.MISTRAL_API_KEY?.trim();
    if (!key) throw new Error("MISTRAL_API_KEY is missing in .env");

    // Pehle models list check karte hain taaki exact quota status pata chale
    const res = await axios.get('https://api.mistral.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 10000
    });
    const modelNames = res.data?.data?.map(m => m.id).slice(0, 5);
    console.log("✅ Mistral Key Valid! Active models:", modelNames);
  } catch (e) {
    console.log("❌ Mistral Error (Status " + (e.response?.status || 'N/A') + "):", e.response?.data?.message || e.response?.data || e.message);
  }

  // 3. HUGGING FACE CHECK (Account & Inference Token)
  console.log("\n--- 3. Testing Hugging Face Token ---");
  try {
    const key = process.env.HUGGINGFACE_API_KEY?.trim();
    if (!key) throw new Error("HUGGINGFACE_API_KEY is missing in .env");

    // Whoami check to verify token permissions
    const whoami = await axios.get('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 10000
    });
    console.log(`✅ HuggingFace Token Valid! User: ${whoami.data?.name || 'Verified'}, Type: ${whoami.data?.type || 'user'}`);
  } catch (e) {
    console.log("❌ HuggingFace Error:", e.response?.data?.error || e.message);
  }

  // 4. FAL.AI CHECK (Balance & Account Lock)
  console.log("\n--- 4. Testing Fal.ai Status ---");
  try {
    const key = process.env.FAL_KEY?.trim();
    if (!key) throw new Error("FAL_KEY is missing in .env");

    // Fal.ai ping check
    const falRes = await axios.post(
      'https://fal.run/fal-ai/flux/schnell',
      { prompt: 'a cute red apple', image_size: 'square_hd', num_inference_steps: 2 },
      {
        headers: {
          'Authorization': `Key ${key}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    if (falRes.data?.images?.[0]?.url) {
      console.log("✅ Fal.ai Working & Has Balance! Image URL:", falRes.data.images[0].url);
    }
  } catch (e) {
    const detail = e.response?.data?.detail || e.response?.data?.message || e.response?.data || e.message;
    console.log("❌ Fal.ai Error (Status " + (e.response?.status || 'N/A') + "):", detail);
  }
}

testRemaining();