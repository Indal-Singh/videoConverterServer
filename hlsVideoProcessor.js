const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const tmp = require('tmp');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
require('dotenv').config();

const {
    Upload
} = require('@aws-sdk/lib-storage');

const {
    S3
} = require('@aws-sdk/client-s3');

ffmpeg.setFfmpegPath(ffmpegStatic);

// Initialize AWS S3
const s3 = new S3({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Video quality configurations
const QUALITY_CONFIGS = [
    { name: '360p', width: 640, height: 360, videoBitrate: '500k', audioBitrate: '64k' },
    { name: '480p', width: 854, height: 480, videoBitrate: '800k', audioBitrate: '96k' },
    { name: '720p', width: 1280, height: 720, videoBitrate: '2500k', audioBitrate: '128k' },
    { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' }
];

async function processVideoToHLS(s3Url, savePath) {
    console.log(`Starting HLS video processing for: ${s3Url}`);
    
    const url = new URL(s3Url);
    const bucket = url.hostname.split('.')[0];
    const key = decodeURIComponent(url.pathname.slice(1));
    const baseName = path.basename(key, path.extname(key));
    
    // Create temporary directory for processing
    const tmpDir = tmp.dirSync({ unsafeCleanup: true });
    const inputTmp = path.join(tmpDir.name, 'input' + path.extname(key));
    const outputDir = path.join(tmpDir.name, 'output');
    
    try {
        // Create output directory
        await fs.ensureDir(outputDir);
        
        // Download video from S3
        console.log('Downloading video from S3...');
        const response = await axios({
            method: 'get',
            url: s3Url,
            responseType: 'stream',
            timeout: 60000
        });

        const writer = fs.createWriteStream(inputTmp);
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Generate thumbnail
        console.log('Generating thumbnail...');
        const thumbnailPath = path.join(outputDir, 'thumbnail.jpg');
        await new Promise((resolve, reject) => {
            ffmpeg(inputTmp)
                .screenshots({
                    timestamps: ['00:00:01'],
                    filename: 'thumbnail.jpg',
                    folder: outputDir
                })
                .on('error', reject)
                .on('end', resolve);
        });

        // Create quality-specific directories
        const qualityDirs = {};
        for (const config of QUALITY_CONFIGS) {
            const qualityDir = path.join(outputDir, config.name);
            await fs.ensureDir(qualityDir);
            qualityDirs[config.name] = qualityDir;
        }

        // Process each quality
        for (const config of QUALITY_CONFIGS) {
            console.log(`Processing ${config.name} quality...`);
            const outputDir = qualityDirs[config.name];
            const outputPath = path.join(outputDir, `${baseName}_${config.name}.mp4`);

            // Convert video to specific quality
            await new Promise((resolve, reject) => {
                ffmpeg(inputTmp)
                    .videoCodec('libx264')
                    .size(`${config.width}x${config.height}`)
                    .videoBitrate(config.videoBitrate)
                    .audioBitrate(config.audioBitrate)
                    .outputOptions([
                        '-preset fast',
                        '-crf 23',
                        '-movflags +faststart'
                    ])
                    .on('error', reject)
                    .on('end', resolve)
                    .save(outputPath);
            });

            // Use FFmpeg to create HLS segments
            const segmentDir = path.join(outputDir, 'segments');
            await fs.ensureDir(segmentDir);

            const ffmpegCmd = `ffmpeg -i "${outputPath}" \
                -c:v libx264 -c:a aac \
                -hls_time 1 \
                -hls_playlist_type vod \
                -hls_segment_filename "${segmentDir}/segment_%03d.ts" \
                -hls_list_size 0 \
                -f hls \
                -hls_flags independent_segments \
                -hls_segment_type mpegts \
                -hls_allow_cache 1 \
                -hls_init_time 1 \
                -hls_base_url "" \
                "${segmentDir}/playlist.m3u8"`;
            

            try {
                console.log('Running FFmpeg command:', ffmpegCmd);
                await execAsync(ffmpegCmd);
                console.log(`Created HLS segments for ${config.name}`);
            } catch (error) {
                console.error(`Error creating HLS segments for ${config.name}:`, error);
                throw error;
            }
        }

        // Create master playlist
        const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
        await createMasterPlaylist(outputDir, masterPlaylistPath);

        // Delete any existing master.mpd file in S3
        try {
            await s3.deleteObject({
                Bucket: bucket,
                Key: path.join(savePath, 'master.mpd')
            });
            console.log('Deleted existing master.mpd file from S3');
        } catch (error) {
            console.log('No existing master.mpd file to delete');
        }

        // Upload all files to S3
        await uploadToS3(outputDir, bucket, savePath);

        // Verify files before upload
        const files = await fs.readdir(outputDir, { recursive: true });
        console.log('Files before upload:', files);

        return {
            masterPlaylistUrl: `https://${bucket}.s3.amazonaws.com/${path.join(savePath, 'master.m3u8')}`,
            thumbnailUrl: `https://${bucket}.s3.amazonaws.com/${path.join(savePath, 'thumbnail.jpg')}`,
            qualities: QUALITY_CONFIGS.map(config => ({
                name: config.name,
                playlistUrl: `https://${bucket}.s3.amazonaws.com/${path.join(savePath, config.name, 'segments/playlist.m3u8')}`
            }))
        };

    } catch (error) {
        console.error('Error processing video:', error);
        throw error;
        // update main server video status to failed
        await axios.post(`${process.env.MAIN_SERVER_URL}/reels/internal/update`, {
            reelId: reelId,
            status: 'failed'
        });
    } finally {
        // Cleanup all temporary files and directories
        try {
            console.log('Cleaning up temporary files...');
            // Remove input file
            if (fs.existsSync(inputTmp)) {
                await fs.unlink(inputTmp);
                console.log('Removed input file:', inputTmp);
            }
            
            // Remove output directory and all its contents
            if (fs.existsSync(outputDir)) {
                await fs.remove(outputDir);
                console.log('Removed output directory:', outputDir);
            }
            
            // Remove temporary directory
            tmpDir.removeCallback();
            console.log('Removed temporary directory:', tmpDir.name);
            // update main server video status to completed
            await axios.post(`${process.env.MAIN_SERVER_URL}/reels/internal/update`, {
                reelId: reelId,
                status: 'done'
            });
        } catch (cleanupError) {
            console.error('Error during cleanup:', cleanupError);
            // update main server video status to failed
            await axios.post(`${process.env.MAIN_SERVER_URL}/reels/internal/update`, {
                reelId: reelId,
                status: 'failed'
            });
        }
    }
}

async function createMasterPlaylist(basePath, outputPath) {
    const playlistContent = `#EXTM3U
#EXT-X-VERSION:3
${QUALITY_CONFIGS.map(config => `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(config.videoBitrate) + parseInt(config.audioBitrate)},RESOLUTION=${config.width}x${config.height}
${config.name}/segments/playlist.m3u8`).join('\n')}`;

    console.log('Creating master playlist at:', outputPath);
    console.log('Playlist content:', playlistContent);
    await fs.writeFile(outputPath, playlistContent);
}

async function uploadToS3(localPath, bucket, s3Path) {
    // Upload all files recursively
    const files = await fs.readdir(localPath, { recursive: true });
    
    for (const file of files) {
        const localFilePath = path.join(localPath, file);
        const stats = await fs.stat(localFilePath);
        
        if (stats.isFile()) {
            const relativePath = path.relative(localPath, localFilePath);
            const s3Key = path.join(s3Path, relativePath).replace(/\\/g, '/');
            
            const fileStream = fs.createReadStream(localFilePath);
            
            await new Upload({
                client: s3,
                params: {
                    Bucket: bucket,
                    Key: s3Key,
                    Body: fileStream,
                    ContentType: getContentType(file),
                    ContentLength: stats.size
                }
            }).done();
            
            console.log(`Uploaded: ${s3Key}`);
        }
    }
}

function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.m3u8':
            return 'application/vnd.apple.mpegurl';
        case '.ts':
            return 'video/mp2t';
        case '.mp4':
            return 'video/mp4';
        case '.jpg':
            return 'image/jpeg';
        default:
            return 'application/octet-stream';
    }
}

module.exports = { processVideoToHLS }; 