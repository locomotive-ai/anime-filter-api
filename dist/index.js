"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const anime_filter_1 = __importDefault(require("./routes/anime-filter"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use('/api/anime-filter', anime_filter_1.default);
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Anime Filter API 服务已启动，端口: ${port}`);
});
