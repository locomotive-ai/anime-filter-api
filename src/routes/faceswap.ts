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
    console.log('>>> Source image fetched successfully, length:', sourceImageBase64.length);

    // 打印视频URL信息
    console.log('>>> Video URL:', videoUrl);
    
    try {
      // 验证视频URL是否可访问
      const videoCheckResponse = await fetch(videoUrl, { method: 'HEAD' });
      console.log('>>> Video URL check status:', videoCheckResponse.status);
      if (!videoCheckResponse.ok) {
        throw new Error(`Video URL is not accessible, status: ${videoCheckResponse.status}`);
      }
    } catch (videoCheckError) {
      console.error('>>> Video URL check failed:', videoCheckError);
      // 继续处理，但记录错误
    }

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
    console.log('>>> API Key length:', segmindApiKey.length);

    // Call Segmind API
    console.log('>>> Calling Segmind API...');
    const segmindRes = await fetch('https://api.segmind.com/v1/videofaceswap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, video/mp4',
        'x-api-key': segmindApiKey
      },
      body: JSON.stringify(data)
    });

    // 记录响应状态和头信息
    console.log('>>> Segmind API response status:', segmindRes.status);
    console.log('>>> Segmind API response headers:', 
      Object.fromEntries([...segmindRes.headers.entries()]));

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      
      try {
        // 尝试解析JSON错误
        const errorJson = JSON.parse(errorText);
        console.error('>>> Parsed error JSON:', errorJson);
        
        throw new Error(
          `Segmind API error: ${errorJson.error || errorJson.message || segmindRes.status}`
        );
      } catch (parseError) {
        // 如果无法解析为JSON，则使用原始错误文本
        throw new Error(`Segmind API error: ${errorText.substring(0, 200)}`);
      }
    }

    // Process response
    const contentType = segmindRes.headers.get('content-type') || '';
    console.log('>>> Response content type:', contentType);
    
    if (contentType.includes('image/jpeg') || contentType.includes('video/mp4')) {
      console.log('>>> Received binary response (image/video)');
      // Get video/image data
      const arrayBuffer = await segmindRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log('>>> Response buffer size:', buffer.length);
      
      try {
        // Upload to Cloudinary
        console.log('>>> Uploading to Cloudinary...');
        const cloudinaryUrl = await uploadToCloudinary(buffer);
        tasks[taskId] = { 
          status: 'success', 
          videoUrl: cloudinaryUrl,
          createdAt: tasks[taskId].createdAt
        };
        console.log(`Task ${taskId} completed: Video uploaded to Cloudinary at ${cloudinaryUrl}`);
      } catch (cloudinaryError: any) {
        console.error(`Cloudinary upload error:`, cloudinaryError);
        
        // Fallback to base64 (not recommended but as a temporary solution)
        console.log('>>> Falling back to base64 encoding...');
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
      console.log('>>> Received JSON response');
      const responseText = await segmindRes.text();
      console.log('>>> Response text:', responseText.substring(0, 200) + '...');
      
      let result;
      try {
        result = JSON.parse(responseText);
        console.log('>>> Parsed JSON result:', result);
      } catch (parseError) {
        console.error('>>> Failed to parse JSON response:', parseError);
        throw new Error('Failed to parse JSON response');
      }
      
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
      console.log(`Task ${taskId} completed successfully with URL: ${url}`);
      return;
    }

    // If other type
    const fallback = await segmindRes.text();
    console.error('>>> Unexpected content type. Response body:', fallback.substring(0, 200) + '...');
    throw new Error(`Unsupported content type: ${contentType}`);

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