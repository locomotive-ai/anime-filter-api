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

const SUPPORTED_DURATIONS = [5, 8];
const SUPPORTED_QUALITIES = ['360p', '540p', '720p', '1080p'];
const SUPPORTED_STYLES = ['anime', '3d_animation', 'clay', 'comic', 'cyberpunk', 'realistic'];

// 上传视频到Cloudinary
const uploadToCloudinary = (buffer: Buffer): Promise<string> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'warmth-of-jesus-videos',
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

// 将图片URL转换为base64
const fetchImageAsBase64 = async (url: string): Promise<string> => {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const arrayBuffer = response.data as ArrayBuffer;
  const buffer = Buffer.from(new Uint8Array(arrayBuffer));
  return buffer.toString('base64');
};

// 处理图片并调用Segmind API
const processImageWithSegmind = async (taskId: string, imageUrl: string, duration: number, quality: string, seed?: number, style?: string) => {
  try {
    tasks[taskId] = { 
      status: 'pending',
      createdAt: Date.now()
    };

    if (!SUPPORTED_DURATIONS.includes(duration)) {
      throw new Error(`Duration not supported. Supported durations: ${SUPPORTED_DURATIONS.join(', ')}`);
    }

    if (!SUPPORTED_QUALITIES.includes(quality)) {
      throw new Error(`Quality not supported. Supported qualities: ${SUPPORTED_QUALITIES.join(', ')}`);
    }

    if (style && !SUPPORTED_STYLES.includes(style)) {
      throw new Error(`Style not supported. Supported styles: ${SUPPORTED_STYLES.join(', ')}`);
    }

    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      throw new Error('SEGMIND_API_KEY is not set');
    }

    // 获取图片的base64编码
    console.log('>>> Fetching image data...');
    const imageBase64 = await fetchImageAsBase64(imageUrl);

    // 准备API请求参数
    const requestData: Record<string, any> = {
      image_url: imageUrl,
      duration: Number(duration),
      quality: quality,
      prompt: "Generate a video of Jesus hugging the person in the image"
    };

    // 如果指定了种子值，则添加参数
    if (seed && !isNaN(seed)) {
      requestData.seed = seed;
    }

    // 如果指定了风格，则添加参数 - 默认不指定风格，让API使用默认值
    if (style && style !== 'realistic') {
      requestData.style = style;
    }

    // 调试信息
    console.log('>>> Segmind payload:', {
      ...requestData,
      image_url: requestData.image_url ? '(image url present)' : undefined
    });

    // 调用Segmind API
    const segmindRes = await fetch('https://api.segmind.com/v1/warmth-of-jesus', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': segmindApiKey
      },
      body: JSON.stringify(requestData)
    });

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      throw new Error(`Segmind API error: ${segmindRes.status}`);
    }

    // 处理返回的视频数据
    const contentType = segmindRes.headers.get('content-type') || '';
    
    if (contentType.includes('video/mp4')) {
      // 获取视频数据
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
      const result = await segmindRes.json() as any;
      const videoUrl = result.output || result.video_url || result.url;

      if (!videoUrl) {
        console.error(`Task ${taskId} - Missing video URL in response:`, result);
        throw new Error('Segmind API JSON missing video URL');
      }

      tasks[taskId] = { 
        status: 'success', 
        videoUrl: videoUrl,
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

// 启动任务的路由
router.post('/start-task', async (req: any, res: any) => {
  try {
    const { imageUrl, duration = 5, quality = '540p', seed, style } = req.body;
    
    // 转换duration为数字
    const durationNum = Number(duration);

    if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//.test(imageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid imageUrl parameter' });
    }
    
    if (!SUPPORTED_DURATIONS.includes(durationNum)) {
      return res.status(400).json({ 
        success: false, 
        error: `Duration not supported. Supported durations: ${SUPPORTED_DURATIONS.join(', ')}` 
      });
    }
    
    if (!SUPPORTED_QUALITIES.includes(quality)) {
      return res.status(400).json({ 
        success: false, 
        error: `Quality not supported. Supported qualities: ${SUPPORTED_QUALITIES.join(', ')}` 
      });
    }

    if (seed !== undefined && (typeof seed !== 'number' || seed < 1 || seed > 999999)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid seed, must be a number between 1 and 999999` 
      });
    }

    if (style && !SUPPORTED_STYLES.includes(style)) {
      return res.status(400).json({ 
        success: false, 
        error: `Style not supported. Supported styles: ${SUPPORTED_STYLES.join(', ')}` 
      });
    }

    const taskId = uuidv4();
    processImageWithSegmind(taskId, imageUrl, durationNum, quality, seed, style);
    return res.json({ success: true, taskId });

  } catch (err: any) {
    console.error("Start task error:", err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to start task' });
  }
});

// 查询任务状态的路由
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

// 定期清理任务数据
setInterval(() => {
  const now = Date.now();
  const expireTime = 24 * 60 * 60 * 1000; // 24小时
  
  Object.entries(tasks).forEach(([taskId, task]) => {
    if (now - task.createdAt > expireTime) {
      delete tasks[taskId];
      console.log(`Deleted expired task: ${taskId}`);
    }
  });
}, 60 * 60 * 1000); // 每小时清理一次

export default router; 