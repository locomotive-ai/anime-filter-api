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
        folder: 'faceswap-videos',
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

const processWithSegmind = async (taskId: string, sourceImageUrl: string, videoUrl: string) => {
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

    // Default videoFaceswap settings
    const data = {
      source_img: sourceImageBase64,
      video_input: videoUrl,
      face_restore: true,
      input_faces_index: 0,
      source_faces_index: 0,
      face_restore_visibility: 1,
      codeformer_weight: 0.95,
      detect_gender_input: "no",
      detect_gender_source: "no",
      frame_load_cap: 0,
      base_64: false
    };

    // Debug info
    console.log('>>> Segmind request payload structure:', Object.keys(data));

    // Call Segmind API
    const segmindRes = await fetch('https://api.segmind.com/v1/videofaceswap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': segmindApiKey
      },
      body: JSON.stringify(data)
    });

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      throw new Error(`Segmind API error: ${segmindRes.status}`);
    }

    // Process response
    const contentType = segmindRes.headers.get('content-type') || '';
    
    if (contentType.includes('image/jpeg') || contentType.includes('video/mp4')) {
      // Get video/image data
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
        const dataUrl = `data:${contentType};base64,${base64}`;
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
    const { sourceImageUrl, videoUrl } = req.body;
    
    if (!sourceImageUrl || typeof sourceImageUrl !== 'string' || !/^https?:\/\//.test(sourceImageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid sourceImageUrl parameter' });
    }
    
    if (!videoUrl || typeof videoUrl !== 'string' || !/^https?:\/\//.test(videoUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid videoUrl parameter' });
    }

    const taskId = uuidv4();
    
    // Process in background
    processWithSegmind(taskId, sourceImageUrl, videoUrl).catch(err => {
      console.error(`Background task ${taskId} error:`, err);
    });
    
    return res.status(202).json({ success: true, taskId });
    
  } catch (err: any) {
    console.error('Start task error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

router.get('/status/:taskId', (req: any, res: any) => {
  const { taskId } = req.params;
  
  if (!taskId) {
    return res.status(400).json({ success: false, error: 'Missing taskId parameter' });
  }
  
  // Clean up old tasks (older than 24 hours)
  const now = Date.now();
  Object.keys(tasks).forEach(key => {
    if (tasks[key].createdAt && now - tasks[key].createdAt > 24 * 60 * 60 * 1000) {
      delete tasks[key];
    }
  });

  const task = tasks[taskId];
  if (!task) {
    return res.status(404).json({ 
      success: false, 
      status: 'not_found',
      error: 'Task not found or expired' 
    });
  }
  
  switch (task.status) {
    case 'success':
      return res.json({ 
        success: true, 
        status: 'success', 
        videoUrl: task.videoUrl 
      });
    case 'failed':
      return res.json({ 
        success: false, 
        status: 'failed', 
        error: task.error || 'Processing failed' 
      });
    case 'pending':
      return res.json({ 
        success: false, 
        status: 'pending',
        waitTime: now - task.createdAt
      });
    default:
      return res.status(500).json({ 
        success: false, 
        error: 'Invalid task status' 
      });
  }
});

export default router; 