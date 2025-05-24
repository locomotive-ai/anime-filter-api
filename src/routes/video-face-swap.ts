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
  videoUrl?: string;
  error?: string;
  createdAt: number; // Creation timestamp
}
const tasks: { [key: string]: Task } = {};

// Upload video to Cloudinary
const uploadToCloudinary = (buffer: Buffer): Promise<string> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'video-face-swap-results',
        resource_type: 'video', 
        timeout: 120000 // 2 minutes timeout
      },
      (error, result) => {
        if (error) return reject(error);
        if (result && result.secure_url) {
          resolve(result.secure_url);
        } else {
          reject(new Error('Failed to get video URL from Cloudinary'));
        }
      }
    );

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
};

const fetchImageAsBase64 = async (url: string): Promise<string> => {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const arrayBuffer = response.data as ArrayBuffer;
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));
  return buffer.toString('base64');
};

const processVideoFaceSwapWithSegmind = async (taskId: string, sourceImageUrl: string, targetVideoUrl: string) => {
  try {
    tasks[taskId] = { 
      status: 'pending',
      createdAt: Date.now()
    };

    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      throw new Error('SEGMIND_API_KEY is not set');
    }

    // Fetch and convert source image to base64
    console.log('>>> Fetching source image...');
    const sourceImageBase64 = await fetchImageAsBase64(sourceImageUrl);

    // Debug info
    console.log('>>> Segmind payload:', {
      source_image: sourceImageBase64.slice(0, 30) + '...',
      target: targetVideoUrl,
      pixel_boost: "384x384",
      face_selector_mode: "reference",
      face_selector_order: "large-small",
      face_selector_age_start: 0,
      face_selector_age_end: 100,
      reference_face_distance: 0.6,
      reference_frame_number: 1,
      base64: false
    });

    // Call Segmind API
    const segmindRes = await fetch('https://api.segmind.com/v1/ai-face-swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': segmindApiKey
      },
      body: JSON.stringify({
        source_image: sourceImageBase64,
        target: targetVideoUrl,
        pixel_boost: "384x384",
        face_selector_mode: "reference",
        face_selector_order: "large-small",
        face_selector_age_start: 0,
        face_selector_age_end: 100,
        reference_face_distance: 0.6,
        reference_frame_number: 1,
        base64: false
      })
    });

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      throw new Error(`Segmind API error: ${segmindRes.status} - ${errorText}`);
    }

    // Process response
    const contentType = segmindRes.headers.get('content-type') || '';
    
    if (contentType.includes('video/mp4') || contentType.includes('application/octet-stream')) {
      // Get video data
      const arrayBuffer = await segmindRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      try {
        // Upload to Cloudinary
        const cloudinaryUrl = await uploadToCloudinary(buffer);
        tasks[taskId] = { 
          status: 'success', 
          videoUrl: cloudinaryUrl,
          createdAt: tasks[taskId].createdAt
        };
        console.log(`Task ${taskId} completed: Video uploaded to Cloudinary`);
      } catch (cloudinaryError: any) {
        console.error(`Cloudinary upload error:`, cloudinaryError);
        
        // Fallback to base64 (not recommended but as a temporary solution)
        const base64 = buffer.toString('base64');
        const dataUrl = `data:video/mp4;base64,${base64}`;
        tasks[taskId] = { 
          status: 'success', 
          videoUrl: dataUrl,
          createdAt: tasks[taskId].createdAt
        };
        console.log(`Task ${taskId} completed with fallback to base64`);
      }
      return;
    }

    // If JSON response
    if (contentType.includes('application/json')) {
      const result = (await segmindRes.json()) as { video?: { url?: string }[] };
      const url = result.video?.[0]?.url;

      if (!url) {
        console.error(`Task ${taskId} - Missing video URL in response:`, result);
        throw new Error('Segmind API JSON missing video URL');
      }

      tasks[taskId] = { 
        status: 'success', 
        videoUrl: url,
        createdAt: tasks[taskId].createdAt
      };
      console.log(`Task ${taskId} completed successfully with URL`);
      return;
    }

    // If other type
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
    const { sourceImageUrl, targetVideoUrl } = req.body;

    if (!sourceImageUrl || typeof sourceImageUrl !== 'string' || !/^https?:\/\//.test(sourceImageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid sourceImageUrl parameter' });
    }
    
    if (!targetVideoUrl || typeof targetVideoUrl !== 'string' || !/^https?:\/\//.test(targetVideoUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid targetVideoUrl parameter' });
    }

    const taskId = uuidv4();
    console.log(`Starting video face swap task ${taskId} with sourceImageUrl: ${sourceImageUrl}, targetVideoUrl: ${targetVideoUrl}`);

    // Start processing asynchronously
    processVideoFaceSwapWithSegmind(taskId, sourceImageUrl, targetVideoUrl);

    res.json({ success: true, taskId });
  } catch (error: any) {
    console.error('Start task error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to start task' });
  }
});

router.get('/status/:taskId', async (req: any, res: any) => {
  try {
    const { taskId } = req.params;
    
    if (!taskId) {
      return res.status(400).json({ success: false, error: 'Missing taskId parameter' });
    }

    const task = tasks[taskId];
    if (!task) {
      return res.status(404).json({ success: false, status: 'not_found', error: 'Task not found or expired' });
    }

    // Check if task is too old (cleanup old tasks)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - task.createdAt > maxAge) {
      delete tasks[taskId];
      return res.status(404).json({ success: false, status: 'not_found', error: 'Task expired' });
    }

    if (task.status === 'success') {
      res.json({ success: true, status: 'success', videoUrl: task.videoUrl });
    } else if (task.status === 'failed') {
      res.json({ success: false, status: 'failed', error: task.error });
    } else {
      res.json({ success: true, status: 'pending' });
    }
  } catch (error: any) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to check status' });
  }
});

// Cleanup old tasks periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  Object.keys(tasks).forEach(taskId => {
    if (now - tasks[taskId].createdAt > maxAge) {
      delete tasks[taskId];
    }
  });
}, 60 * 60 * 1000); // Run every hour

export default router; 