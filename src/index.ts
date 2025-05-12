import express from 'express';
import dotenv from 'dotenv';
import animeFilterRouter from './routes/anime-filter';

dotenv.config();

const app = express();
app.use(express.json());

app.use('/api/anime-filter', animeFilterRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Anime Filter API 服务已启动，端口: ${port}`);
});