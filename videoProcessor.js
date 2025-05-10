const fs = require('fs-extra');
const path = require('path');
const tmp = require('tmp');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
require('dotenv').config(); // Load environment variables from .env file


const {
    Upload
} = require('@aws-sdk/lib-storage');

const {
    S3
} = require('@aws-sdk/client-s3');

ffmpeg.setFfmpegPath(ffmpegStatic);

// Initialize AWS S3 with a specified region and credentials
const s3 = new S3({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

async function processVideoFromS3Url(s3Url) {
    console.log(`Starting video processing for: ${s3Url}`);
    
    const url = new URL(s3Url);
    
    // Extract bucket name more reliably
    let bucket;
    if (url.hostname.includes('.s3.')) {
        // Format: bucket-name.s3.region.amazonaws.com
        bucket = url.hostname.split('.')[0];
    } else if (url.hostname === 's3.amazonaws.com') {
        // Format: s3.amazonaws.com/bucket-name/...
        bucket = url.pathname.split('/')[1];
        // Adjust the key to remove bucket name from path
        const pathParts = url.pathname.split('/');
        pathParts.splice(0, 2); // Remove empty string and bucket name
        url.pathname = '/' + pathParts.join('/');
    } else {
        throw new Error(`Unable to determine bucket name from URL: ${s3Url}`);
    }
    
    console.log(`Detected bucket: ${bucket}`);
    
    const key = decodeURIComponent(url.pathname.slice(1)); // remove leading "/"
    console.log(`Detected key: ${key}`);
    
    const baseName = path.basename(key, path.extname(key));
    const ext = path.extname(key);
    const newKey = key.replace(baseName + ext, `${baseName}_480p${ext}`);
    
    console.log(`Will save processed video to: ${newKey}`);

    const inputTmp = tmp.tmpNameSync({ postfix: ext });
    const outputTmp = tmp.tmpNameSync({ postfix: ext });

    try {
        console.log(`Downloading video from ${s3Url}...`);
        // Download the video
        const response = await axios({
            method: 'get',
            url: s3Url,
            responseType: 'stream',
            timeout: 60000 // 60 second timeout for large files
        });

        const writer = fs.createWriteStream(inputTmp);
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        console.log('Download complete. Starting conversion...');

        // Get video information before processing
        const videoInfo = await getVideoInfo(inputTmp);
        console.log('Original video information:', videoInfo);

        // Convert to 480p
        await new Promise((resolve, reject) => {
            ffmpeg(inputTmp)
                .videoCodec('libx264')
                .size('854x480') // 16:9 aspect ratio at 480p
                .outputOptions([
                    '-preset fast',
                    '-crf 23',
                    '-movflags +faststart' // Optimize for web streaming
                ])
                .on('error', (err) => {
                    console.error('FFmpeg error:', err);
                    reject(err);
                })
                .on('progress', (progress) => {
                    console.log(`Processing: ${Math.floor(progress.percent || 0)}% done`);
                })
                .on('end', () => {
                    console.log('FFmpeg processing finished');
                    resolve();
                })
                .save(outputTmp);
        });
        console.log('Conversion complete. Uploading to S3...');

        // Upload the converted file back to S3
        const fileStream = fs.createReadStream(outputTmp);
        const fileStats = fs.statSync(outputTmp);

        await new Upload({
            client: s3,
            params: {
                Bucket: bucket,
                Key: newKey,
                Body: fileStream,
                ContentType: 'video/mp4',
                ContentLength: fileStats.size,
            }
        }).done();

        const newUrl = `https://${bucket}.s3.amazonaws.com/${newKey}`;
        console.log(`Video successfully uploaded to: ${newUrl}`);
        return newUrl;
    } catch (error) {
        console.error('Error processing video:', error);
        throw error;
    } finally {
        // Clean up temporary files
        try {
            if (fs.existsSync(inputTmp)) fs.removeSync(inputTmp);
            if (fs.existsSync(outputTmp)) fs.removeSync(outputTmp);
            console.log('Temporary files cleaned up');
        } catch (cleanupError) {
            console.error('Error cleaning up temp files:', cleanupError);
        }
    }
}

// Helper function to get video information
function getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                return reject(err);
            }
            
            const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
            if (!videoStream) {
                return reject(new Error('No video stream found'));
            }
            
            resolve({
                width: videoStream.width,
                height: videoStream.height,
                duration: videoStream.duration,
                codec: videoStream.codec_name,
                bitrate: videoStream.bit_rate,
                frameRate: eval(videoStream.r_frame_rate)
            });
        });
    });
}

// Example usage
async function main() {
    try {
        const s3Url = 'https://media-playsport.s3.amazonaws.com/your-video-file.mp4';
        const processedUrl = await processVideoFromS3Url(s3Url);
        console.log('Processing complete. Processed video URL:', processedUrl);
    } catch (error) {
        console.error('Main process error:', error);
    }
}

// Uncomment to run directly
// main();

module.exports = { processVideoFromS3Url };