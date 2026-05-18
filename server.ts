import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const upload = multer({ dest: "tmp/" });

// Ensure tmp directory exists
if (!fs.existsSync("tmp")) {
  fs.mkdirSync("tmp");
}

ffmpeg.getAvailableFormats((err) => {
  if (err) {
    console.error("FFMPEG INITIALIZATION ERROR:", err);
  } else {
    console.log("FFMPEG is ready and available.");
  }
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json({ limit: "50mb" }));
  
  // Convert WebM to MP4 endpoint
  app.post("/api/video/render", upload.single("video"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }
    
    console.log("Received video file to convert:", req.file.path);
    const inputPath = req.file.path;
    const outputPath = path.join("tmp", `${req.file.filename}.mp4`);
    
    // Convert the webm to mp4
    ffmpeg(inputPath)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 192k',
        '-movflags +faststart'
      ])
      .save(outputPath)
      .on('end', () => {
        console.log("Conversion finished! Sending MP4 back.");
        res.download(outputPath, "final_video.mp4", (err) => {
          if (err) console.error("Error sending file:", err);
          
          // Cleanup
          fs.unlink(inputPath, () => {});
          fs.unlink(outputPath, () => {});
        });
      })
      .on('error', (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "Conversion failed" });
        // Cleanup
        fs.unlink(inputPath, () => {});
      });
  });

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
