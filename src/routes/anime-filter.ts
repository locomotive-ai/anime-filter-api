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

    if (!segmindRes.ok) {
      responseBodyText = await segmindRes.text();
      console.error(`---> Task ${taskId} - Segmind API !ok: Status ${segmindRes.status}, Body: ${responseBodyText}`);
      throw new Error(`Segmind API error: Status ${segmindRes.status}`);
    }
    if (!contentType.includes('application/json')) {
      responseBodyText = responseBodyText ?? await segmindRes.text();
      console.error(`---> Task ${taskId} - Segmind API non-JSON: Content-Type: ${contentType}, Body: ${responseBodyText}`);
      throw new Error('Segmind API did not return JSON');
    }

    responseBodyText = responseBodyText ?? await segmindRes.text();
    const result = JSON.parse(responseBodyText) as { image?: string };

    if (!result.image) {
      console.error(`---> Task ${taskId} - Segmind API JSON missing image field. Body: ${responseBodyText}`);
      throw new Error('Segmind API did not return image');
    }

    // Update task status to success
    tasks[taskId] = { status: 'success', imageUrl: result.image };
    console.log(`Task ${taskId} completed successfully.`);

  } catch (err: any) {
    console.error(`---> Task ${taskId} processing failed:`, err);
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