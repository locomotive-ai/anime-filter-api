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
        response_format: "url" // <- 重点修改
      })
    });

    const contentType = segmindRes.headers.get('content-type') || '';
    const responseBodyText = await segmindRes.text();

    if (!segmindRes.ok) {
      console.error(`Task ${taskId} - Segmind API !ok: ${segmindRes.status}`, responseBodyText);
      throw new Error(`Segmind API error: ${segmindRes.status}`);
    }

    if (!contentType.includes('application/json')) {
      console.error(`Task ${taskId} - Unexpected content-type: ${contentType}`, responseBodyText);
      throw new Error(`Segmind API did not return JSON (got ${contentType})`);
    }

    let result: any;
    try {
      result = JSON.parse(responseBodyText);
    } catch (e) {
      console.error(`Task ${taskId} - Failed to parse JSON:`, responseBodyText);
      throw new Error('Failed to parse JSON from Segmind');
    }

    const url = result.images?.[0]?.url;
    if (!url) {
      console.error(`Task ${taskId} - Missing image URL in response:`, result);
      throw new Error('Segmind API JSON missing image URL');
    }

    tasks[taskId] = { status: 'success', imageUrl: url };
    console.log(`Task ${taskId} completed successfully`);
  } catch (err: any) {
    console.error(`Task ${taskId} failed:`, err);
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
    processImageWithSegmind(taskId, imageUrl, style); // async task

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
