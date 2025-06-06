import express from 'express';
import dotenv from 'dotenv';
import animeFilterRouter from './routes/anime-filter';
import aiKissRouter from './routes/ai-kiss';
import aiHugRouter from './routes/ai-hug'; 
import warmthOfJesusRouter from './routes/warmth-of-jesus';
import muscleSurgeRouter from './routes/muscle-surge';
import jellycatEffectRouter from './routes/jellycat-effect';
import videoFaceSwapRouter from './routes/video-face-swap';
import musicGeneratorRouter from './routes/music-generator';
import celebritySelfieRouter from './routes/celebrity-selfie';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/api/anime-filter', animeFilterRouter);
app.use('/api/ai-kiss', aiKissRouter);
app.use('/api/ai-hug', aiHugRouter); 
app.use('/api/warmth-of-jesus', warmthOfJesusRouter);
app.use('/api/muscle-surge', muscleSurgeRouter);
app.use('/api/jellycat-effect', jellycatEffectRouter);
app.use('/api/video-face-swap', videoFaceSwapRouter);
app.use('/api/music-generator', musicGeneratorRouter);
app.use('/api/celebrity-selfie', celebritySelfieRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`AI Creative API service started on port: ${port}`);
});