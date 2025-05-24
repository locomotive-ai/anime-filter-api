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
  createdAt: number; // Add creation time field
}
const tasks: { [key: string]: Task } = {};

// Supported parameter values based on Segmind API
const SUPPORTED_PIXEL_BOOST = ['128x128', '256x256', '384x384', '512x512', '768x768', '1024x1024'];
const SUPPORTED_FACE_SELECTOR_MODE = ['many', 'one', 'reference'];
const SUPPORTED_FACE_SELECTOR_ORDER = ['left-right', 'right-left', 'top-bottom', 'bottom-top', 'small-large', 'large-small', 'best-worst', 'worst-best'];
const SUPPORTED_FACE_SELECTOR_GENDER = ['female', 'male', 'none'];
const SUPPORTED_FACE_SELECTOR_RACE = ['white', 'black', 'asian', 'indian', 'middle eastern', 'latino hispanic', 'none'];

// Upload video to Cloudinary with size limit check
const uploadToCloudinary = (buffer: Buffer): Promise<string> => {
  return new Promise((resolve, reject) => {
    // Check file size limit (100MB for safety)
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB in bytes
    
    if (buffer.length > MAX_FILE_SIZE) {
      reject(new Error(`Video file too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Maximum allowed size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`));
      return;
    }

    console.log(`Uploading video to Cloudinary (size: ${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
    
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'video-face-swap-videos',
        resource_type: 'video', 
        timeout: 120000, // 2 minutes timeout
        chunk_size: 6000000 // 6MB chunks for large files
      },
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error);
          return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        }
        if (result && result.secure_url) {
          console.log(`Video uploaded successfully to Cloudinary: ${result.secure_url}`);
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
  try {
    console.log(`Fetching image from: ${url}`);
    const response = await axios.get(url, { 
      responseType: 'arraybuffer',
      timeout: 30000 // 30 seconds timeout
    });
    
    const arrayBuffer = response.data as ArrayBuffer;
    const buffer = Buffer.from(new Uint8Array(arrayBuffer));
    const base64 = buffer.toString('base64');
    
    // Get content type from response headers
    const contentType = response.headers['content-type'] || 'image/jpeg';
    console.log(`Image fetched successfully, size: ${buffer.length} bytes, type: ${contentType}`);
    
    // Return base64 with data URL prefix for validation
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.error('Error fetching image:', error);
    throw new Error(`Failed to fetch source image: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const processVideoFaceSwapWithSegmind = async (
  taskId: string, 
  sourceImageUrl: string, 
  targetVideoUrl: string,
  pixelBoost: string,
  faceSelectorMode: string,
  faceSelectorOrder: string,
  faceSelectorAgeStart: number,
  faceSelectorAgeEnd: number,
  referenceFaceDistance: number,
  referenceFrameNumber: number
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

    // Fetch source image as base64
    console.log('>>> Fetching source image...');
    const sourceImageWithDataUrl = await fetchImageAsBase64(sourceImageUrl);
    
    // Extract just the base64 part (remove data:image/...;base64, prefix)
    const base64Match = sourceImageWithDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!base64Match) {
      throw new Error('Invalid base64 format for source image');
    }
    const sourceImageBase64 = base64Match[2];
    const imageType = base64Match[1];
    
    console.log(`Source image type: ${imageType}, base64 length: ${sourceImageBase64.length}`);

    // Prepare the payload for Segmind AI Face Swap API
    const payload = {
      source_image: sourceImageBase64, // Just base64 without data URL prefix
      target: targetVideoUrl, // URL for target video
      pixel_boost: pixelBoost,
      face_selector_mode: faceSelectorMode,
      face_selector_order: faceSelectorOrder,
      face_selector_gender: "none", // Default to no gender filter
      face_selector_race: "none", // Default to no race filter
      face_selector_age_start: faceSelectorAgeStart,
      face_selector_age_end: faceSelectorAgeEnd,
      reference_face_distance: referenceFaceDistance,
      reference_frame_number: referenceFrameNumber,
      base64: false // Return URL instead of base64
    };

    // Print debug info
    console.log('>>> Segmind payload:', {
      source_image: sourceImageBase64.slice(0, 30) + '...(' + sourceImageBase64.length + ' chars)',
      target: targetVideoUrl,
      pixel_boost: pixelBoost,
      face_selector_mode: faceSelectorMode,
      face_selector_order: faceSelectorOrder,
      face_selector_gender: "none",
      face_selector_race: "none",
      face_selector_age_start: faceSelectorAgeStart,
      face_selector_age_end: faceSelectorAgeEnd,
      reference_face_distance: referenceFaceDistance,
      reference_frame_number: referenceFrameNumber,
      base64: false
    });
    
    // Validate base64 format
    if (!sourceImageBase64 || sourceImageBase64.length < 100) {
      throw new Error('Source image base64 is too short or empty');
    }
    if (!/^[A-Za-z0-9+/]+(=*)$/.test(sourceImageBase64)) {
      throw new Error('Source image base64 contains invalid characters');
    }

    // Call Segmind API
    const segmindRes = await fetch('https://api.segmind.com/v1/ai-face-swap', {
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
      
      // Try to parse error message
      let errorMessage = `Segmind API error (${segmindRes.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error) {
          errorMessage = errorJson.error;
        }
      } catch (e) {
        console.log('Could not parse error as JSON, using raw text');
        errorMessage = errorText || errorMessage;
      }
      
      throw new Error(errorMessage);
    }

    // Handle returned video data
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
        
        // If Cloudinary upload fails, fallback to base64 (not recommended, but as temporary solution)
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

    // If it's JSON response
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
      sourceImageUrl, 
      targetVideoUrl,
      pixelBoost = '384x384',
      faceSelectorMode = 'reference',
      faceSelectorOrder = 'large-small',
      faceSelectorAgeStart = 0,
      faceSelectorAgeEnd = 100,
      referenceFaceDistance = 0.6,
      referenceFrameNumber = 1
    } = req.body;

    if (!sourceImageUrl || typeof sourceImageUrl !== 'string' || !/^https?:\/\//.test(sourceImageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid sourceImageUrl parameter' });
    }
    
    if (!targetVideoUrl || typeof targetVideoUrl !== 'string' || !/^https?:\/\//.test(targetVideoUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid targetVideoUrl parameter' });
    }
    
    if (!SUPPORTED_PIXEL_BOOST.includes(pixelBoost)) {
      return res.status(400).json({ 
        success: false, 
        error: `Pixel boost not supported. Supported values: ${SUPPORTED_PIXEL_BOOST.join(', ')}` 
      });
    }

    if (!SUPPORTED_FACE_SELECTOR_MODE.includes(faceSelectorMode)) {
      return res.status(400).json({ 
        success: false, 
        error: `Face selector mode not supported. Supported modes: ${SUPPORTED_FACE_SELECTOR_MODE.join(', ')}` 
      });
    }

    if (!SUPPORTED_FACE_SELECTOR_ORDER.includes(faceSelectorOrder)) {
      return res.status(400).json({ 
        success: false, 
        error: `Face selector order not supported. Supported orders: ${SUPPORTED_FACE_SELECTOR_ORDER.join(', ')}` 
      });
    }

    const taskId = uuidv4();
    processVideoFaceSwapWithSegmind(
      taskId, 
      sourceImageUrl, 
      targetVideoUrl,
      pixelBoost,
      faceSelectorMode,
      faceSelectorOrder,
      faceSelectorAgeStart,
      faceSelectorAgeEnd,
      referenceFaceDistance,
      referenceFrameNumber
    );
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
      videoUrl: task.videoUrl,
      processTime: Date.now() - task.createdAt // Add processing time info
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
      waitTime: Date.now() - task.createdAt // Add wait time info
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
    console.log(`Cleaned ${cleanCount} expired Video Face Swap tasks`);
  }
}, 30 * 60 * 1000); // Execute cleanup every 30 minutes

export default router; 