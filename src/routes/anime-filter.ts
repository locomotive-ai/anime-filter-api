import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const SUPPORTED_STYLES = ['ghibli'];

// 用 any 兜底，彻底消除类型报错
router.post('/', async (req: any, res: any) => {
  try {
    const { imageUrl, style } = req.body;

    // 校验参数
    if (!imageUrl || typeof imageUrl !== 'string' || !/^https?:\/\//.test(imageUrl)) {
      return res.status(400).json({ success: false, error: '参数 imageUrl 无效' });
    }
    if (!style || !SUPPORTED_STYLES.includes(style)) {
      return res.status(400).json({ success: false, error: '仅支持 ghibli 风格' });
    }

    // 构建 prompt
    const prompt = "Ghibli anime style, cinematic lighting, expressive face, digital painting";
    const negativePrompt = "blurry, ugly, bad quality, extra limbs, deformed face";

    // 调用 Segmind API
    const segmindApiKey = process.env.SEGMIND_API_KEY;
    if (!segmindApiKey) {
      return res.status(500).json({ success: false, error: '未配置 SEGMIND_API_KEY' });
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
        num_inference_steps: 30
      })
    });

    const contentType = segmindRes.headers.get('content-type') || '';
    if (!segmindRes.ok) {
      const errorText = await segmindRes.text();
      return res.status(500).json({ success: false, error: `Segmind API 错误: ${errorText}` });
    }
    if (!contentType.includes('application/json')) {
      return res.status(500).json({ success: false, error: 'Segmind API 返回的不是 JSON' });
    }

    const result = await segmindRes.json() as { image?: string };
    if (!result.image) {
      return res.status(500).json({ success: false, error: 'Segmind API 未返回图片' });
    }

    return res.json({ success: true, imageUrl: result.image });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || '服务器错误' });
  }
});

export default router;