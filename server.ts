import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "50mb" }));

function getGeminiKeys(clientProvidedKeys?: string[]): string[] {
  if (clientProvidedKeys && clientProvidedKeys.length > 0) {
    return clientProvidedKeys;
  }
  const keysStr = process.env.GEMINI_API_KEYS;
  if (!keysStr) return [];
  try {
    if (keysStr.startsWith('[')) {
      return JSON.parse(keysStr);
    } else {
      return keysStr.split(/[,\s\n]+/).map(k => k.trim()).filter(Boolean);
    }
  } catch (e) {
    return keysStr.split(/[,\s\n]+/).map(k => k.trim()).filter(Boolean);
  }
}

function getWorkerUrls(clientProvidedUrls?: string[]): string[] {
  if (clientProvidedUrls && clientProvidedUrls.length > 0) {
    return clientProvidedUrls;
  }
  const urlsStr = process.env.IMAGE_WORKER_URLS;
  if (!urlsStr) return [
    "https://flux1.shreevathsa2k27.workers.dev/",
    "https://flux.shreevathsa2k21-4fa.workers.dev/",
    "https://flux.vaishakhaphotos2.workers.dev/",
    "https://flux.vmajibail.workers.dev/"
  ];
  try {
    if (urlsStr.startsWith('[')) {
      return JSON.parse(urlsStr);
    } else {
      return urlsStr.split(/[,\s\n]+/).map(u => u.trim()).filter(Boolean);
    }
  } catch (e) {
    return urlsStr.split(/[,\s\n]+/).map(u => u.trim()).filter(Boolean);
  }
}

let currentApiIndex = 0;

// Helper to sleep
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function generateContentWithRetry(params: any, clientProvidedKeys?: string[]): Promise<any> {
    const keys = getGeminiKeys(clientProvidedKeys);
    if (!keys || keys.length === 0) {
      throw new Error("No Gemini API keys found. Please configure GEMINI_API_KEYS in .env or Settings");
    }

    let lastError: any = null;
    let attempts = 0;
    while (attempts < keys.length) {
      if (currentApiIndex >= keys.length) {
        currentApiIndex = 0;
      }
      
      const client = new GoogleGenAI({ apiKey: keys[currentApiIndex] });
      const currentAttemptIndex = currentApiIndex;
      currentApiIndex = (currentApiIndex + 1) % keys.length;
      attempts++;
      
      try {
        const res = await client.models.generateContent(params);
        return res;
      } catch (err: any) {
        lastError = err;
        const msg = (typeof err === 'string' ? err : (err.message || JSON.stringify(err) || "")).toLowerCase();
        
        if (msg.includes('quota') || msg.includes('429') || msg.includes('limit') || msg.includes('exhausted')) {
           console.warn(`Key ${currentAttemptIndex} exhausted, rotating...`);
           if (attempts < keys.length) await sleep(2000); 
           continue; 
        }
        console.warn(`Key failed (attempt ${attempts}), rotating... Error:`, err);
        if (attempts < keys.length) await sleep(1000);
      }
    }
    
    const errorString = typeof lastError === 'string' ? lastError : (lastError.message || JSON.stringify(lastError));
    throw new Error(`Exhausted all ${keys.length} provided Gemini API keys. Final error: ${errorString}`);
}

app.post("/api/gemini/generate", async (req, res) => {
  try {
    const { clientProvidedKeys, ...params } = req.body;
    const response = await generateContentWithRetry(params, clientProvidedKeys);
    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

app.post("/api/flux/generate", async (req, res) => {
  try {
    const { prompt, clientProvidedUrls } = req.body;
    const workerUrls = getWorkerUrls(clientProvidedUrls);
    
    const shuffledUrls = [...workerUrls].sort(() => Math.random() - 0.5);
    let lastError: any = null;

    for (const workerUrl of shuffledUrls) {
      try {
        console.log(`[Flux Proxy Backend] Trying URL: ${workerUrl}`);
        const response = await fetch(workerUrl.trim(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[Flux Backend Error] ${workerUrl}:`, response.status, errorText);
          
          if (response.status === 429 || response.status >= 500) {
            lastError = { status: response.status, text: errorText };
            continue;
          }
          throw new Error(errorText || `HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        let uintArray = new Uint8Array(arrayBuffer);

        if (uintArray[0] === 123) { // '{' character, possible JSON
          const textData = new TextDecoder("utf-8").decode(uintArray);
          try {
            const json = JSON.parse(textData);
            const b64 = json.image || json.result?.image || json.img;
            if (b64) {
              const base64Data = b64.replace(/^data:image\/\w+;base64,/, "");
              const buffer = Buffer.from(base64Data, 'base64');
              res.setHeader('Content-Type', 'image/jpeg');
              return res.send(buffer);
            }
          } catch (e) {
            console.error("JSON parse failed", e);
          }
        }
        
        const buffer = Buffer.from(arrayBuffer);
        res.setHeader('Content-Type', 'image/jpeg');
        return res.send(buffer);

      } catch (error: any) {
        console.error(`[Flux Proxy Exception] ${workerUrl}:`, error.message);
        lastError = { status: 500, text: error.message };
        continue;
      }
    }

    try {
      console.log(`[Flux Backend] Using Pollinations fallback`);
      const response = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=720&height=1280&nologo=true`, {
        signal: AbortSignal.timeout(15000)
      });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        res.setHeader('Content-Type', 'image/jpeg');
        return res.send(buffer);
      }
    } catch (e) {
      console.error("[Flux Proxy] Pollinations fallback failed:", e);
    }

    throw new Error(lastError?.text || "All workers failed");
  } catch (error: any) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
