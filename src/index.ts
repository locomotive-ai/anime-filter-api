import express from 'express';
import dotenv from 'dotenv';
import animeFilterRouter from './routes/anime-filter';
import aiKissRouter from './routes/ai-kiss';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/api/anime-filter', animeFilterRouter);
app.use('/api/ai-kiss', aiKissRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`AI Creative API service started on port: ${port}`);
});