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

const SUPPORTED_STYLES = [
  'ghibli', 
  'family_guy', 
  'southpark', 
  'simpsons',
  'shinkai_makoto',
  'animal_crossing',
  'jojo',
  'pixar',
  'lego',
  'chibi',
  'oil_painting',
  '3d_style',
  'barbie'
];

const processImageWithSegmind = async (taskId: string, imageUrl: string, style: string) => {
  try {
    tasks[taskId] = { status: 'pending' };

    if (!SUPPORTED_STYLES.includes(style)) {
      throw new Error(`Style not supported. Supported styles: ${SUPPORTED_STYLES.join(', ')}`);
    }

    // 根据风格选择不同的提示词
    let prompt;
    const negativePrompt = "blurry, ugly, bad quality, extra limbs, deformed face";

    if (style === 'ghibli') {
      prompt = "Ghibli studio style";
    } else if (style === 'family_guy') {
      prompt = "Family Guy cartoon style, cartoon animation style";
    } else if (style === 'southpark') {
      prompt = "South Park cartoon style, flat color paper cutout animation style";
    } else if (style === 'simpsons') {
      prompt = "The Simpsons cartoon style, yellow skin, animation style";
    } else if (style === 'shinkai_makoto') {
      prompt = "Japanese Anime “Your Name” style";
    } else if (style === 'animal_crossing') {
      prompt = "Animal Crossing game style, cute cartoon character, Nintendo game art style";
    } else if (style === 'jojo') {
      prompt = "JoJo's Bizarre Adventure style";
    } else if (style === 'pixar') {
      prompt = "Pixar 3D animation style, Pixar movie character, 3D rendered";
    } else if (style === 'lego') {
      prompt = "LEGO minifigure style, plastic toy, blocky LEGO character";
    } else if (style === 'chibi') {
      prompt = "Chibi anime style, cute small character, big head, kawaii";
    } else if (style === 'oil_painting') {
      prompt = "Classical oil painting style, painterly, artistic brush strokes";
    } else if (style === '3d_style') {
      prompt = "Modern 3D character style, detailed 3D rendering, high quality CGI";
    } else if (style === 'barbie') {
      prompt = "Barbie doll style, plastic doll appearance, toy character";
    } else {
      // 添加兜底处理，虽然前面已经检查过，但为了逻辑的完整性还是加上
      throw new Error(`Unsupported style: ${style}`);
    }

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
        size: "auto",
        quality: "auto",
        background: "opaque",
        output_compression: 100
      })
    });

    const contentType = segmindRes.headers.get('content-type') || '';

    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      console.error(`Segmind API error (${segmindRes.status}):`, errorText);
      throw new Error(`Segmind API error: ${segmindRes.status}`);
    }

    if (contentType.includes('image/jpeg')) {
      const arrayBuffer = await segmindRes.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      tasks[taskId] = { status: 'success', imageUrl: dataUrl };
      console.log(`Task ${taskId} completed successfully with JPEG`);
      return;
    }

    if (contentType.includes('application/json')) {
      const result = (await segmindRes.json()) as { images?: { url?: string }[] };
      const url = result.images?.[0]?.url;

      if (!url) {
        console.error(`Task ${taskId} - Missing image URL in response:`, result);
        throw new Error('Segmind API JSON missing image URL');
      }

      tasks[taskId] = { status: 'success', imageUrl: url };
      console.log(`Task ${taskId} completed successfully with URL`);
      return;
    }

    // 如果是其他类型
    const fallback = await segmindRes.text();
    throw new Error(`Unsupported content type: ${contentType}\nBody: ${fallback}`);

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
      return res.status(400).json({ 
        success: false, 
        error: `Style not supported. Supported styles: ${SUPPORTED_STYLES.join(', ')}` 
      });
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
