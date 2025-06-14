const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const tmp = require('tmp');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const Logger = require('./utils/logger');
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
    { name: '360p', maxHeight: 360, videoBitrate: '500k', audioBitrate: '64k' },
    { name: '480p', maxHeight: 480, videoBitrate: '800k', audioBitrate: '96k' },
    { name: '720p', maxHeight: 720, videoBitrate: '2500k', audioBitrate: '128k' },
    { name: '1080p', maxHeight: 1080, videoBitrate: '5000k', audioBitrate: '192k' }
];

async function processVideoToHLS(s3Url, savePath, reelId) {
    const url = new URL(s3Url);
    const bucket = url.hostname.split('.')[0];
    const key = decodeURIComponent(url.pathname.slice(1));
    const baseName = path.basename(key, path.extname(key));
    
    // Initialize logger
    const logger = new Logger(baseName);
    await logger.initialize();
    
    logger.info(`Starting HLS video processing for: ${s3Url}`);
    
    // Create temporary directory for processing
    const tmpDir = tmp.dirSync({ unsafeCleanup: true });
    const inputTmp = path.join(tmpDir.name, 'input' + path.extname(key));
    const outputDir = path.join(tmpDir.name, 'output');
    
    try {
        // Create output directory
        await fs.ensureDir(outputDir);
        
        // Download video from S3
        logger.info('Downloading video from S3...');
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

        // Get video information
        const videoInfo = await getVideoInfo(inputTmp);
        logger.info('Original video information:', videoInfo);

        // Calculate aspect ratio
        const aspectRatio = videoInfo.width / videoInfo.height;
        // console.log('Video aspect ratio:', aspectRatio);

        // Generate thumbnail
        logger.info('Generating thumbnail...');
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
            logger.info(`Processing ${config.name} quality...`);
            const outputDir = qualityDirs[config.name];
            const outputPath = path.join(outputDir, `${baseName}_${config.name}.mp4`);

            // Calculate dimensions maintaining aspect ratio
            let targetHeight = config.maxHeight;
            let targetWidth = Math.round(targetHeight * aspectRatio);

            // Ensure width is even (required by some codecs)
            if (targetWidth % 2 !== 0) {
                targetWidth += 1;
            }

            logger.info(`Target dimensions for ${config.name}: ${targetWidth}x${targetHeight}`);

            // Convert video to specific quality
            await new Promise((resolve, reject) => {
                ffmpeg(inputTmp)
                    .videoCodec('libx264')
                    .size(`${targetWidth}x${targetHeight}`)
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
                logger.info('Running FFmpeg command:', ffmpegCmd);
                await execAsync(ffmpegCmd);
                logger.info(`Created HLS segments for ${config.name}`);
            } catch (error) {
                logger.error(`Error creating HLS segments for ${config.name}:`, error);
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
            logger.info('Deleted existing master.mpd file from S3');
        } catch (error) {
            logger.info('No existing master.mpd file to delete');
        }

        // Upload all files to S3
        await uploadToS3(outputDir, bucket, savePath);

        // Verify files before upload
        const files = await fs.readdir(outputDir, { recursive: true });
        logger.info('Files before upload:', files);

        return {
            masterPlaylistUrl: `https://${bucket}.s3.amazonaws.com/${path.join(savePath, 'master.m3u8')}`,
            thumbnailUrl: `https://${bucket}.s3.amazonaws.com/${path.join(savePath, 'thumbnail.jpg')}`,
            qualities: QUALITY_CONFIGS.map(config => ({
                name: config.name,
                playlistUrl: `https://${bucket}.s3.amazonaws.com/${path.join(savePath, config.name, 'segments/playlist.m3u8')}`
            }))
        };

    } catch (error) {
        // update main server video status to failed
        await axios.post(`${process.env.MAIN_SERVER_URL}/reels/internal/update`, {
            reelId: reelId,
            video_proccessed_status: 'failed'
        });
        logger.error('Error processing video:', error);
        throw error;
    } finally {
        // Cleanup all temporary files and directories
        try {
            logger.info('Cleaning up temporary files...');
            // Remove input file
            if (fs.existsSync(inputTmp)) {
                await fs.unlink(inputTmp);
                logger.info('Removed input file:', inputTmp);
            }
            
            // Remove output directory and all its contents
            if (fs.existsSync(outputDir)) {
                await fs.remove(outputDir);
                logger.info('Removed output directory:', outputDir);
            }
            
            // Remove temporary directory
            tmpDir.removeCallback();
            logger.info('Removed temporary directory:', tmpDir.name);
            // update main server video status to completed
            await axios.post(`${process.env.MAIN_SERVER_URL}/reels/internal/update`, {
                reelId: reelId,
                video_proccessed_status: 'done'
            });
        } catch (cleanupError) {
            logger.error('Error during cleanup:', cleanupError);
            // update main server video status to failed
            await axios.post(`${process.env.MAIN_SERVER_URL}/reels/internal/update`, {
                reelId: reelId,
                video_proccessed_status: 'failed'
            });
        } finally {
            await logger.end();
        }
    }
}

async function createMasterPlaylist(basePath, outputPath) {
    const playlistContent = `#EXTM3U
#EXT-X-VERSION:3
${QUALITY_CONFIGS.map(config => `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(config.videoBitrate) + parseInt(config.audioBitrate)},RESOLUTION=${config.maxHeight}x${config.maxHeight}
${config.name}/segments/playlist.m3u8`).join('\n')}`;

    logger.info('Creating master playlist at:', outputPath);
    logger.info('Playlist content:', playlistContent);
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
            
            logger.info(`Uploaded: ${s3Key}`);
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

// Helper function to get video information
function getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error('Error getting video info:', err);
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

module.exports = { processVideoToHLS }; 