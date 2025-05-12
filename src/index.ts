import express from 'express';
import dotenv from 'dotenv';
import animeFilterRouter from './routes/anime-filter';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/api/anime-filter', animeFilterRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Anime Filter API service started on port: ${port}`);
});