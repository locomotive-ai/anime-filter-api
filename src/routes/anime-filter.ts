import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

interface Task {
  status: 'pending' | 'success' | 'failed';
  imageUrl?: string;
  error?: string;
}
const tasks: { [key: string]: Task } = {};

const SUPPORTED_STYLES = ['ghibli'];

const processImageWithSegmind = async (taskId: string, imageUrl: string, style: string) => {
  try {
    tasks[taskId] = { status: 'pending' };

    if (!SUPPORTED_STYLES.includes(style)) {
      throw new Error('Only ghibli style is supported');
    }

    const prompt = "Ghibli anime style, cinematic lighting, expressive face, digital painting";
    const negativePrompt = "blurry, ugly, bad quality, extra limbs, deformed face";

    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      throw new Error('SEGMIND_API_KEY is not set');
    }

    const segmindRes = await fetch('https://api.segmind.com/v1/gpt-image-1-edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${segmindApiKey}`
      },
      body: JSON.stringify({
        image_urls: [imageUrl],
        prompt,
        negative_prompt: negativePrompt,
        guidance_scale: 5,
        num_inference_steps: 30,
        response_format: "url"  // 使用url替代b64_json，更稳定
      })
    });

    const contentType = segmindRes.headers.get('content-type') || '';
    const responseBodyText = await segmindRes.text();
    const isJson = contentType.includes('application/json');

    if (!segmindRes.ok) {
      console.error(`---> Task ${taskId} - API Error: ${segmindRes.status}, Body: ${responseBodyText}`);
      let detailError = `Segmind API error: ${segmindRes.status}`;
      if (isJson) {
        try {
          const parsed = JSON.parse(responseBodyText);
          detailError = parsed.error || parsed.message || detailError;
        } catch { }
      }
      throw new Error(detailError);
    }

    if (!isJson) {
      console.error(`🚨 Task ${taskId} - Content-Type: ${contentType}`);
      console.error(`🚨 Task ${taskId} - Body (truncated): ${responseBodyText.slice(0, 500)}...`);
      
      // 检测是否返回了HTML错误页面
      if (responseBodyText.includes('<html')) {
        console.error(`🔴 HTML error response received from Segmind! Possible 502/503 error or rate limit`);
      }
      
      throw new Error(`Segmind API did not return JSON (Content-Type: ${contentType})`);
    }

    let result: any;
    try {
      result = JSON.parse(responseBodyText);
    } catch (e) {
      console.error(`---> Task ${taskId} - JSON parse failed. Body: ${responseBodyText}`, e);
      throw new Error('Failed to parse JSON response from Segmind');
    }

    if (!result.images || !Array.isArray(result.images) || !result.images[0]?.url) {
      console.error(`---> Task ${taskId} - Missing image URL. Body: ${responseBodyText}`);
      throw new Error('Segmind API JSON did not contain valid image URL');
    }

    // 直接使用返回的URL
    const resultImageUrl = result.images[0].url;
    tasks[taskId] = { status: 'success', imageUrl: resultImageUrl };
    console.log(`Task ${taskId} completed successfully.`);
  } catch (err: any) {
    console.error(`---> Task ${taskId} failed:`, err);
    tasks[taskId] = { status: 'failed', error: err.message || 'Server error' };
  }
};

router.post('/start-task', async (req: any, res: any) => {
  try {
    const { imageUrl, style } = req.body;

    if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//.test(imageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid imageUrl parameter' });
    }
    if (!style || !SUPPORTED_STYLES.includes(style)) {
      return res.status(400).json({ success: false, error: 'Only ghibli style is supported' });
    }

    const taskId = uuidv4();
    processImageWithSegmind(taskId, imageUrl, style);

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
    return res.json({ success: true, status: 'success', imageUrl: task.imageUrl });
  } else if (task.status === 'failed') {
    return res.status(500).json({ success: false, status: 'failed', error: task.error });
  } else {
    return res.json({ success: false, status: 'pending' });
  }
});

export default router;
