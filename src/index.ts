import express from 'express';
import dotenv from 'dotenv';
import animeFilterRouter from './routes/anime-filter';
import aiKissRouter from './routes/ai-kiss';
import aiHugRouter from './routes/ai-hug'; 
import warmthOfJesusRouter from './routes/warmth-of-jesus';
import muscleSurgeRouter from './routes/muscle-surge';
import jellycatEffectRouter from './routes/jellycat-effect';
import faceswapRouter from './routes/faceswap';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/api/anime-filter', animeFilterRouter);
app.use('/api/ai-kiss', aiKissRouter);
app.use('/api/ai-hug', aiHugRouter); 
app.use('/api/warmth-of-jesus', warmthOfJesusRouter);
app.use('/api/muscle-surge', muscleSurgeRouter);
app.use('/api/jellycat-effect', jellycatEffectRouter);
app.use('/api/faceswap', faceswapRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`AI Creative API service started on port: ${port}`);
});