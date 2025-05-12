import express from 'express';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid'; // Need to install uuid: npm install uuid @types/uuid

const router = express.Router();

// In-memory store for task status (replace with Redis/DB in production)
interface Task {
  status: 'pending' | 'success' | 'failed';
  imageUrl?: string;
  error?: string;
}
const tasks: { [key: string]: Task } = {};

const SUPPORTED_STYLES = ['ghibli'];

// --- Helper Function for Segmind API Call (async, no await) ---
const processImageWithSegmind = async (taskId: string, imageUrl: string, style: string) => {
  try {
    // Update status to pending
    tasks[taskId] = { status: 'pending' };

    // Validate style (redundant but safe)
    if (!SUPPORTED_STYLES.includes(style)) {
      throw new Error('Only ghibli style is supported');
    }

    // Build prompt
    const prompt = "Ghibli anime style, cinematic lighting, expressive face, digital painting";
    const negativePrompt = "blurry, ugly, bad quality, extra limbs, deformed face";

    // Get API Key
    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      throw new Error('SEGMIND_API_KEY is not set');
    }

    // Call Segmind API (actual call, might take time)
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
        num_inference_steps: 30
      })
      // No timeout here, let it run
    });

    const contentType = segmindRes.headers.get('content-type') || '';
    let responseBodyText: string | null = null;
    let isJson = false;

    try {
      responseBodyText = await segmindRes.text(); // **始终先获取文本**
      isJson = contentType.includes('application/json');
    } catch (readError: any) {
      // 如果连读取响应体都失败了
      console.error(`---> Task ${taskId} - Failed to read Segmind response body:`, readError);
      throw new Error('Failed to read response from Segmind API');
    }

    if (!segmindRes.ok) {
      console.error(`---> Task ${taskId} - Segmind API !ok: Status ${segmindRes.status}, Body: ${responseBodyText}`);
      // 即使 !ok，也尝试从 Body 解析错误信息（如果它是 JSON 的话）
      let detailError = `Segmind API error: Status ${segmindRes.status}`;
      if (isJson && responseBodyText) {
          try {
              const parsedError = JSON.parse(responseBodyText);
              detailError = parsedError.error || parsedError.message || detailError;
          } catch(e) { /* ignore parse error */ }
      }
      throw new Error(detailError);
    }

    if (!isJson) {
      console.error(`---> Task ${taskId} - Segmind API non-JSON: Content-Type: ${contentType}, Body: ${responseBodyText}`);
      throw new Error('Segmind API did not return JSON');
    }

    // **现在确定是 JSON，可以安全解析**
    let result: any;
    try {
        result = JSON.parse(responseBodyText); // 使用已获取的文本
    } catch (parseError: any) {
        console.error(`---> Task ${taskId} - Failed to parse Segmind JSON response: ${responseBodyText}`, parseError);
        throw new Error('Failed to parse JSON response from Segmind API');
    }
    
    if (!result.image) {
      console.error(`---> Task ${taskId} - Segmind API JSON missing image field. Body: ${responseBodyText}`);
      throw new Error('Segmind API did not return image field');
    }

    // Update task status to success
    tasks[taskId] = { status: 'success', imageUrl: result.image };
    console.log(`Task ${taskId} completed successfully.`);

  } catch (err: any) {
    // Log the caught error before updating status
    console.error(`---> Task ${taskId} processing failed (outer catch):`, err);
    tasks[taskId] = { status: 'failed', error: err.message || 'Server error' };
  }
};

// --- API Endpoints ---

// POST /api/anime-filter/start-task - Start processing and return taskId
router.post('/start-task', async (req: any, res: any) => {
  try {
    const { imageUrl, style } = req.body;

    // Validate params
    if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//.test(imageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid imageUrl parameter' });
    }
    if (!style || !SUPPORTED_STYLES.includes(style)) {
      return res.status(400).json({ success: false, error: 'Only ghibli style is supported' });
    }

    // Generate unique task ID
    const taskId = uuidv4();

    // Start processing asynchronously (don't await)
    processImageWithSegmind(taskId, imageUrl, style);

    // Immediately return taskId
    return res.json({ success: true, taskId });

  } catch (err: any) {
    console.error("Error starting task:", err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to start task' });
  }
});

// GET /api/anime-filter/status/:taskId - Check task status
router.get('/status/:taskId', async (req: any, res: any) => {
  const { taskId } = req.params;

  if (!taskId) {
    return res.status(400).json({ success: false, error: 'Missing taskId parameter' });
  }

  const task = tasks[taskId];

  if (!task) {
    // If task doesn't exist yet, treat as pending or error depending on desired behavior
     return res.status(404).json({ success: false, status: 'not_found', error: 'Task not found' });
     // Or return pending immediately: return res.json({ success: false, status: 'pending' });
  }

  if (task.status === 'success') {
    return res.json({ success: true, status: 'success', imageUrl: task.imageUrl });
  } else if (task.status === 'failed') {
    return res.status(500).json({ success: false, status: 'failed', error: task.error });
  } else { // pending
    return res.json({ success: false, status: 'pending' });
  }
});

export default router;