/**
 * Segmind API测试脚本
 * 
 * 运行方法:
 * 1. 确保有一个测试图片 test-image.jpg
 * 2. 运行: SEGMIND_API_KEY=your_api_key node test-segmind.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // 加载环境变量

// 从文件读取图片并转换为base64
function imageFileToBase64(imagePath) {
    const imageData = fs.readFileSync(path.resolve(imagePath));
    return Buffer.from(imageData).toString('base64');
}

// 主测试函数
async function testSegmindApi() {
    try {
        console.log('Testing Segmind API connection...');
        
        // 检查API密钥是否存在
        const apiKey = process.env.SEGMIND_API_KEY;
        if (!apiKey) {
            console.error('❌ SEGMIND_API_KEY is not set in environment variables');
            console.error('Please run the script with: SEGMIND_API_KEY=your_api_key node test-segmind.js');
            return;
        }
        console.log(`✅ API Key found (length: ${apiKey.length})`);
        
        // 测试图片路径 - 可以根据需要修改
        const testImagePath = './test-image.jpg'; // 请确保此文件存在
        if (!fs.existsSync(testImagePath)) {
            console.error(`❌ Test image not found at ${testImagePath}`);
            return;
        }
        
        // 转换图片为base64
        console.log('Converting image to base64...');
        const imageBase64 = imageFileToBase64(testImagePath);
        console.log(`✅ Image converted to base64 (length: ${imageBase64.length})`);
        
        // 测试视频URL - 使用公开可访问的示例视频
        // 这个是一个样例公开视频，也可以替换成其他任何公开视频URL
        const testVideoUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
        console.log(`Using test video: ${testVideoUrl}`);
        
        // 准备请求数据
        const requestData = {
            source_img: imageBase64,
            video_input: testVideoUrl,
            face_restore: true,
            input_faces_index: 0,
            source_faces_index: 0,
            face_restore_visibility: 1,
            codeformer_weight: 0.95,
            detect_gender_input: "no",
            detect_gender_source: "no",
            frame_load_cap: 0, // 0表示处理整个视频
            base_64: false
        };
        
        console.log('Sending request to Segmind API...');
        console.log('This may take a while depending on the video length...');
        
        // 发送请求到Segmind API
        const response = await axios.post('https://api.segmind.com/v1/videofaceswap', requestData, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, video/mp4',
                'x-api-key': apiKey
            },
            responseType: 'arraybuffer',
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 300000 // 5分钟超时
        });
        
        // 检查响应
        console.log(`✅ Response received: status ${response.status} ${response.statusText}`);
        console.log('Response headers:', response.headers);
        
        if (response.headers['content-type'].includes('application/json')) {
            // JSON响应
            const jsonData = JSON.parse(Buffer.from(response.data).toString());
            console.log('JSON Response:', jsonData);
        } else if (response.headers['content-type'].includes('video/mp4') || 
                   response.headers['content-type'].includes('image/jpeg')) {
            // 二进制响应 (视频/图像)
            const outputPath = './segmind-output.mp4';
            fs.writeFileSync(outputPath, response.data);
            console.log(`✅ Output saved to ${outputPath}`);
        } else {
            console.log('Unknown response type:', response.headers['content-type']);
            // 保存未知格式的输出以供分析
            fs.writeFileSync('./segmind-unknown-output', response.data);
            console.log('Unknown format output saved to ./segmind-unknown-output');
        }
        
    } catch (error) {
        console.error('❌ Test failed with error:');
        if (error.response) {
            // 服务器响应了错误状态码
            console.error(`Status: ${error.response.status}`);
            console.error('Headers:', error.response.headers);
            
            // 尝试解析错误内容
            if (error.response.data) {
                try {
                    if (error.response.data.toString) {
                        const data = error.response.data.toString('utf8');
                        console.error('Error data:', data);
                        try {
                            const jsonData = JSON.parse(data);
                            console.error('Parsed error data:', jsonData);
                        } catch (e) {
                            // 不是JSON格式，已经输出了原始数据
                        }
                    } else {
                        console.error('Error data (binary):', error.response.data);
                    }
                } catch (e) {
                    console.error('Cannot parse error data');
                }
            }
        } else if (error.request) {
            // 请求已发送但没有收到响应
            console.error('No response received from server');
        } else {
            // 请求配置有问题
            console.error('Error message:', error.message);
        }
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
    }
}

// 运行测试
testSegmindApi(); 