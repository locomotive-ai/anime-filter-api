import express from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
  secure: true
});

const router = express.Router();

interface Task {
  status: 'pending' | 'success' | 'failed';
  audioUrl?: string;
  error?: string;
  createdAt: number;
}
const tasks: { [key: string]: Task } = {};

// Upload audio to Cloudinary
const uploadToCloudinary = (buffer: Buffer): Promise<string> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'music-generator-audio',
        resource_type: 'video', // Use 'video' for audio files
        timeout: 120000 // 2 minutes timeout
      },
      (error, result) => {
        if (error) return reject(error);
        if (result && result.secure_url) {
          resolve(result.secure_url);
        } else {
          reject(new Error('Failed to get audio URL from Cloudinary'));
        }
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

const processWithSegmind = async (
  taskId: string, 
  genres: string, 
  lyrics: string, 
  duration: number, 
  lyricsStrength: number, 
  pitchShift: number, 
  steps: number, 
  cfg: number, 
  seed: number | null
) => {
  try {
    tasks[taskId] = { 
      status: 'pending',
      createdAt: Date.now()
    };

    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      throw new Error('SEGMIND_API_KEY is not set');
    }

    // Prepare payload for Segmind ACE-Step Music API
    const payload: any = {
      genres,
      lyrics,
      lyrics_strength: lyricsStrength,
      output_seconds: duration,
      shift: pitchShift,
      steps,
      cfg,
      base64: false
    };

    // Add seed if provided
    if (seed !== null && seed !== undefined) {
      payload.seed = seed;
    }

    console.log('>>> Segmind Music Generator payload:', {
      ...payload,
      lyrics: lyrics.slice(0, 50) + '...'
    });

    // Call Segmind ACE-Step Music API
    const segmindRes = await fetch('https://api.segmind.com/v1/ace-step-music', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': segmindApiKey
      },
      body: JSON.stringify(payload)
    });

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      throw new Error(`Segmind API error: ${segmindRes.status}`);
    }

    // Handle returned audio data
    const contentType = segmindRes.headers.get('content-type') || '';
    
    if (contentType.includes('audio/') || contentType.includes('video/') || contentType.includes('application/octet-stream')) {
      // Get audio data
      const arrayBuffer = await segmindRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      try {
        // Upload to Cloudinary
        const cloudinaryUrl = await uploadToCloudinary(buffer);
        tasks[taskId] = { 
          status: 'success', 
          audioUrl: cloudinaryUrl,
          createdAt: tasks[taskId].createdAt
        };
        console.log(`Task ${taskId} completed: Audio uploaded to Cloudinary`);
      } catch (cloudinaryError: any) {
        console.error(`Cloudinary upload error:`, cloudinaryError);
        
        // If Cloudinary upload fails, fallback to base64 (not recommended, but as temporary solution)
        const base64 = buffer.toString('base64');
        const dataUrl = `data:${contentType};base64,${base64}`;
        tasks[taskId] = { 
          status: 'success', 
          audioUrl: dataUrl,
          createdAt: tasks[taskId].createdAt
        };
        console.log(`Task ${taskId} completed with fallback to base64`);
      }
      return;
    }

    // If it's JSON response
    if (contentType.includes('application/json')) {
      const result = (await segmindRes.json()) as { audio?: { url?: string }[] };
      const url = result.audio?.[0]?.url;

      if (!url) {
        console.error(`Task ${taskId} - Missing audio URL in response:`, result);
        throw new Error('Segmind API JSON missing audio URL');
      }

      tasks[taskId] = { 
        status: 'success', 
        audioUrl: url,
        createdAt: tasks[taskId].createdAt
      };
      console.log(`Task ${taskId} completed successfully with URL`);
      return;
    }

    // If it's other type
    const fallback = await segmindRes.text();
    throw new Error(`Unsupported content type: ${contentType}\nBody: ${fallback}`);

  } catch (err: any) {
    console.error(`Task ${taskId} failed:`, err);
    tasks[taskId] = { 
      status: 'failed', 
      error: err.message || 'Server error',
      createdAt: tasks[taskId]?.createdAt || Date.now() 
    };
  }
};

router.post('/start-task', async (req: any, res: any) => {
  try {
    const { 
      genres, 
      lyrics, 
      duration = 60, 
      lyricsStrength = 1, 
      pitchShift = 4, 
      steps = 50, 
      cfg = 4, 
      seed 
    } = req.body;

    // Validate parameters
    if (!genres || typeof genres !== 'string' || genres.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid genres parameter' });
    }
    
    if (!lyrics || typeof lyrics !== 'string' || lyrics.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid lyrics parameter' });
    }
    
    if (typeof duration !== 'number' || duration < 10 || duration > 240) {
      return res.status(400).json({ success: false, error: 'Invalid duration parameter (10-240)' });
    }
    
    if (typeof lyricsStrength !== 'number' || lyricsStrength < 0.1 || lyricsStrength > 10) {
      return res.status(400).json({ success: false, error: 'Invalid lyricsStrength parameter (0.1-10)' });
    }
    
    if (typeof pitchShift !== 'number' || pitchShift < 0 || pitchShift > 10) {
      return res.status(400).json({ success: false, error: 'Invalid pitchShift parameter (0-10)' });
    }
    
    if (typeof steps !== 'number' || steps < 10 || steps > 150) {
      return res.status(400).json({ success: false, error: 'Invalid steps parameter (10-150)' });
    }
    
    if (typeof cfg !== 'number' || cfg < 1 || cfg > 15) {
      return res.status(400).json({ success: false, error: 'Invalid cfg parameter (1-15)' });
    }
    
    if (seed !== null && seed !== undefined && !Number.isInteger(seed)) {
      return res.status(400).json({ success: false, error: 'Invalid seed parameter' });
    }

    const taskId = uuidv4();
    processWithSegmind(taskId, genres, lyrics, duration, lyricsStrength, pitchShift, steps, cfg, seed);
    return res.json({ success: true, taskId });

  } catch (err: any) {
    console.error("Start task error:", err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to start task' });
  }
});

router.get('/status/:taskId', async (req: any, res: any) => {
  const { taskId } = req.params;

  if (!taskId) {
    return res.status(400).json({ success: false, error: 'Missing taskId parameter' });
  }

  const task = tasks[taskId];
  if (!task) {
    return res.status(404).json({ success: false, status: 'not_found', error: 'Task not found' });
  }

  if (task.status === 'success') {
    return res.json({ 
      success: true, 
      status: 'success', 
      audioUrl: task.audioUrl,
      processTime: Date.now() - task.createdAt
    });
  } else if (task.status === 'failed') {
    return res.status(500).json({ 
      success: false, 
      status: 'failed', 
      error: task.error,
      processTime: Date.now() - task.createdAt
    });
  } else {
    return res.json({ 
      success: false, 
      status: 'pending',
      waitTime: Date.now() - task.createdAt
    });
  }
});

// Add scheduled task to clean old tasks older than 2 hours
setInterval(() => {
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  let cleanCount = 0;

  Object.entries(tasks).forEach(([taskId, task]) => {
    if (task.createdAt < twoHoursAgo) {
      delete tasks[taskId];
      cleanCount++;
    }
  });

  if (cleanCount > 0) {
    console.log(`Cleaned ${cleanCount} expired Music Generator tasks`);
  }
}, 30 * 60 * 1000); // Execute cleanup every 30 minutes

export default router; 