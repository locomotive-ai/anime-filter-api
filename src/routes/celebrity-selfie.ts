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

const SUPPORTED_CELEBRITIES = [
  'jackie_chan',
  'michael_jackson', 
  'leonardo_dicaprio',
  'will_smith',
  'brad_pitt',
  'angelina_jolie',
  'tom_cruise',
  'scarlett_johansson',
  'robert_downey_jr'
];

const SUPPORTED_LANDMARKS = [
  'oriental_pearl',
  'eiffel_tower',
  'colosseum',
  'statue_of_liberty',
  'big_ben',
  'sydney_opera_house',
  'mount_fuji',
  'taj_mahal',
  'machu_picchu',
  'great_wall',
  'golden_gate_bridge',
  'christ_redeemer'
];

// Celebrity name mapping
const CELEBRITY_NAMES: { [key: string]: string } = {
  'jackie_chan': 'Jackie Chan',
  'michael_jackson': 'Michael Jackson',
  'leonardo_dicaprio': 'Leonardo DiCaprio',
  'taylor_swift': 'Taylor Swift',
  'will_smith': 'Will Smith',
  'brad_pitt': 'Brad Pitt',
  'angelina_jolie': 'Angelina Jolie',
  'tom_cruise': 'Tom Cruise',
  'scarlett_johansson': 'Scarlett Johansson',
  'robert_downey_jr': 'Robert Downey Jr.'
};

// Landmark name mapping
const LANDMARK_NAMES: { [key: string]: string } = {
  'oriental_pearl': 'Oriental Pearl Tower in Shanghai',
  'eiffel_tower': 'Eiffel Tower in Paris',
  'colosseum': 'Colosseum in Rome',
  'statue_of_liberty': 'Statue of Liberty in New York',
  'big_ben': 'Big Ben in London',
  'sydney_opera_house': 'Sydney Opera House in Australia',
  'mount_fuji': 'Mount Fuji in Japan',
  'taj_mahal': 'Taj Mahal in India',
  'machu_picchu': 'Machu Picchu in Peru',
  'great_wall': 'Great Wall of China',
  'golden_gate_bridge': 'Golden Gate Bridge in San Francisco',
  'christ_redeemer': 'Christ the Redeemer statue in Rio de Janeiro'
};

const processImageWithSegmind = async (taskId: string, imageUrl: string, celebrity: string, landmark: string) => {
  try {
    tasks[taskId] = { status: 'pending' };

    if (!SUPPORTED_LANDMARKS.includes(landmark)) {
      throw new Error(`Landmark not supported. Supported landmarks: ${SUPPORTED_LANDMARKS.join(', ')}`);
    }

    // Get celebrity and landmark names
    let celebrityName;
    if (celebrity.startsWith('custom_')) {
      // Handle custom celebrity input
      celebrityName = celebrity.replace('custom_', '').replace(/_/g, ' ');
      // Capitalize each word
      celebrityName = celebrityName.split(' ').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(' ');
    } else if (CELEBRITY_NAMES[celebrity]) {
      // Handle predefined celebrities
      celebrityName = CELEBRITY_NAMES[celebrity];
    } else {
      throw new Error(`Celebrity not supported. Supported celebrities: ${SUPPORTED_CELEBRITIES.join(', ')}`);
    }

    const landmarkName = LANDMARK_NAMES[landmark];

    // Create the specific prompt for celebrity selfie
    const prompt = `A deliberately mundane and awkward iPhone selfie featuring [person in the image] and ${celebrityName} casually posing together in front of ${landmarkName}. The photo should look completely unplanned—no intentional framing, poor composition, and slightly off-angle, as if taken hastily. Include subtle motion blur, uneven lighting with mild overexposure, and a messy, cramped frame (like it was accidentally snapped while pulling the phone from a pocket). The overall vibe should be an intentionally bad, forgettable snapshot—zero artistic effort, just an ordinary, awkward moment captured.`;

    const negativePrompt = "blurry, ugly, bad quality, extra limbs, deformed face, professional photography, perfect composition, studio lighting";

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

    // If other content type
    const fallback = await segmindRes.text();
    throw new Error(`Unsupported content type: ${contentType}\nBody: ${fallback}`);

  } catch (err: any) {
    console.error(`Task ${taskId} failed:`, err);
    tasks[taskId] = { status: 'failed', error: err.message || 'Server error' };
  }
};

router.post('/start-task', async (req: any, res: any) => {
  try {
    const { imageUrl, celebrity, landmark } = req.body;

    if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//.test(imageUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid imageUrl parameter' });
    }
    if (!celebrity || (!SUPPORTED_CELEBRITIES.includes(celebrity) && !celebrity.startsWith('custom_'))) {
      return res.status(400).json({ 
        success: false, 
        error: `Celebrity not supported. Supported celebrities: ${SUPPORTED_CELEBRITIES.join(', ')} or custom celebrity names` 
      });
    }
    if (!landmark || !SUPPORTED_LANDMARKS.includes(landmark)) {
      return res.status(400).json({ 
        success: false, 
        error: `Landmark not supported. Supported landmarks: ${SUPPORTED_LANDMARKS.join(', ')}` 
      });
    }

    const taskId = uuidv4();
    processImageWithSegmind(taskId, imageUrl, celebrity, landmark);
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