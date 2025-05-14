import express from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';

// 配置Cloudinary
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
  createdAt: number; // 添加创建时间字段
}
const tasks: { [key: string]: Task } = {};

const SUPPORTED_MODES = ['std', 'pro'];
const SUPPORTED_DURATIONS = [5, 10]; // 修改为数字数组

// 上传视频到Cloudinary
const uploadToCloudinary = (buffer: Buffer): Promise<string> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'ai-kiss-videos',
        resource_type: 'video', 
        timeout: 120000 // 2分钟超时
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

const processImagesWithSegmind = async (taskId: string, firstImageUrl: string, secondImageUrl: string, mode: string, duration: number) => {
  try {
    tasks[taskId] = { 
      status: 'pending',
      createdAt: Date.now()
    };

    if (!SUPPORTED_MODES.includes(mode)) {
      throw new Error(`Mode not supported. Supported modes: ${SUPPORTED_MODES.join(', ')}`);
    }

    if (!SUPPORTED_DURATIONS.includes(duration)) {
      throw new Error(`Duration not supported. Supported durations: ${SUPPORTED_DURATIONS.join(', ')}`);
    }

    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      throw new Error('SEGMIND_API_KEY is not set');
    }

    // 使用新的方法获取base64
    console.log('>>> Fetching first image...');
    const firstImageBase64 = await fetchImageAsBase64(firstImageUrl);
    console.log('>>> Fetching second image...');
    const secondImageBase64 = await fetchImageAsBase64(secondImageUrl);

    // 打印调试信息
    console.log('>>> Segmind payload:', {
      first_reference_image: firstImageBase64.slice(0, 30) + '...',
      second_reference_image: secondImageBase64.slice(0, 30) + '...',
      mode,
      duration: Number(duration)
    });

    // 调用Segmind API
    const segmindRes = await fetch('https://api.segmind.com/v1/kling-kiss', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': segmindApiKey
      },
      body: JSON.stringify({
        first_reference_image: firstImageBase64,
        second_reference_image: secondImageBase64,
        mode: mode,
        duration: Number(duration)
      })
    });

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      throw new Error(`Segmind API error: ${segmindRes.status}`);
    }

    // 处理返回的视频数据
    const contentType = segmindRes.headers.get('content-type') || '';
    
    if (contentType.includes('image/jpeg') || contentType.includes('video/mp4')) {
      // 获取视频/图片数据
      const arrayBuffer = await segmindRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      try {
        // 上传到Cloudinary
        const cloudinaryUrl = await uploadToCloudinary(buffer);
        tasks[taskId] = { 
          status: 'success', 
          videoUrl: cloudinaryUrl,
          createdAt: tasks[taskId].createdAt
        };
        console.log(`Task ${taskId} completed: Video uploaded to Cloudinary`);
      } catch (cloudinaryError: any) {
        console.error(`Cloudinary upload error:`, cloudinaryError);
        
        // 如果Cloudinary上传失败，回退到base64（不推荐，但作为临时方案）
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

    // 如果是JSON响应
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

    // 如果是其他类型
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
    const { firstImageUrl, secondImageUrl, mode = 'pro', duration = 5 } = req.body;
    
    // 转换duration为数字
    const durationNum = Number(duration);

    if (!firstImageUrl || typeof firstImageUrl !== 'string' || !/^https?:\/\//.test(firstImageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid firstImageUrl parameter' });
    }
    
    if (!secondImageUrl || typeof secondImageUrl !== 'string' || !/^https?:\/\//.test(secondImageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid secondImageUrl parameter' });
    }
    
    if (!SUPPORTED_MODES.includes(mode)) {
      return res.status(400).json({ 
        success: false, 
        error: `Mode not supported. Supported modes: ${SUPPORTED_MODES.join(', ')}` 
      });
    }
    
    if (!SUPPORTED_DURATIONS.includes(durationNum)) {
      return res.status(400).json({ 
        success: false, 
        error: `Duration not supported. Supported durations: ${SUPPORTED_DURATIONS.join(', ')}` 
      });
    }

    const taskId = uuidv4();
    processImagesWithSegmind(taskId, firstImageUrl, secondImageUrl, mode, durationNum);
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
      processTime: Date.now() - task.createdAt // 添加处理时间信息
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
      waitTime: Date.now() - task.createdAt // 添加等待时间信息
    });
  }
});

// 添加定时任务清理超过2小时的旧任务
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
    console.log(`Cleaned ${cleanCount} expired AI Kiss tasks`);
  }
}, 30 * 60 * 1000); // 每30分钟执行一次清理

export default router; 