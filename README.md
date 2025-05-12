# Anime Filter API 微服务

## 环境变量
- SEGMIND_API_KEY
- PORT（可选，默认3000）

## 启动
yarn install
yarn build
yarn start

## API
POST /api/anime-filter
{
  "imageUrl": "https://res.cloudinary.com/xxx.png",
  "style": "ghibli"
}