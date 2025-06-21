import fs from 'fs-extra';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import tmp from 'tmp';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import Logger from './utils/logger.js';
import dotenv from 'dotenv';
import { Upload } from '@aws-sdk/lib-storage';
import { S3 } from '@aws-sdk/client-s3';

const execAsync = promisify(exec);
dotenv.config();

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

// Add axios retry configuration
const axiosInstance = axios.create({
    timeout: 30000, // 30 seconds timeout
    maxContentLength: 50 * 1024 * 1024, // 50MB max content length
    maxBodyLength: 50 * 1024 * 1024, // 50MB max body length
    validateStatus: function (status) {
        return status >= 200 && status < 300; // Only accept 2xx status codes
    }
});

// Add retry interceptor
axiosInstance.interceptors.response.use(null, async (error) => {
    const config = error.config;
    
    // If no config or no retry count, initialize retry count
    if (!config || !config.retryCount) {
        config.retryCount = 0;
    }
    
    // Maximum number of retries
    const maxRetries = 3;
    
    if (config.retryCount < maxRetries) {
        config.retryCount += 1;
        
        // Exponential backoff delay
        const delay = Math.pow(2, config.retryCount) * 1000;
        
        // Log retry attempt
        console.log(`Retrying request (${config.retryCount}/${maxRetries}) after ${delay}ms delay`);
        
        // Wait for the delay
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Retry the request
        return axiosInstance(config);
    }
    
    return Promise.reject(error);
});

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
    
    let processingError = null;
    
    try {
        // Create output directory
        await fs.ensureDir(outputDir);
        
        // Download video from S3 with enhanced error handling
        logger.info('Downloading video from S3...');
        try {
            const response = await axiosInstance({
                method: 'get',
                url: s3Url,
                responseType: 'stream',
                timeout: 60000,
                retryCount: 0
            });

            const writer = fs.createWriteStream(inputTmp);
            await new Promise((resolve, reject) => {
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            logger.info('Video downloaded successfully');
        } catch (downloadError) {
            logger.error('Failed to download video:', downloadError);
            throw new Error(`Video download failed: ${downloadError.message}`);
        }

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
        await createMasterPlaylist(outputDir, masterPlaylistPath, logger);

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
        processingError = error;
        logger.error('Error processing video:', error);
        
        // Enhanced error handling for status update
        try {
            const statusUpdateResponse = await axiosInstance({
                method: 'post',
                url: `${process.env.MAIN_SERVER_URL}/reels/internal/update`,
                data: {
                    reelId: reelId,
                    video_proccessed_status: 'failed',
                    error_message: error.message,
                    error_details: {
                        name: error.name,
                        stack: error.stack,
                        code: error.code
                    }
                },
                timeout: 10000,
                retryCount: 0
            });
            
            logger.info('Status update sent successfully');
        } catch (statusUpdateError) {
            logger.error('Failed to update status:', statusUpdateError);
        }
        
        throw error;
    } finally {
        // Cleanup all temporary files and directories
        try {
            console.log('\n=== Starting Cleanup Process ===');
            logger.info('Starting cleanup process...');

            // Check if files exist before attempting to delete
            const inputFileExists = fs.existsSync(inputTmp);
            const outputDirExists = fs.existsSync(outputDir);

            console.log('File status before cleanup:');
            console.log(`Input file exists: ${inputFileExists}`);
            console.log(`Output directory exists: ${outputDirExists}`);

            // Remove input file
            if (inputFileExists) {
                try {
                    await fs.unlink(inputTmp);
                    console.log('✅ Removed input file:', inputTmp);
                    logger.info('Removed input file:', inputTmp);
                } catch (inputFileError) {
                    console.error('❌ Error removing input file:', inputFileError);
                    logger.error('Error removing input file:', inputFileError);
                }
            } else {
                console.log('ℹ️ Input file does not exist, skipping removal');
            }
            
            // Remove output directory and all its contents
            if (outputDirExists) {
                try {
                    await fs.remove(outputDir);
                    console.log('✅ Removed output directory:', outputDir);
                    logger.info('Removed output directory:', outputDir);
                } catch (outputDirError) {
                    console.error('❌ Error removing output directory:', outputDirError);
                    logger.error('Error removing output directory:', outputDirError);
                }
            } else {
                console.log('ℹ️ Output directory does not exist, skipping removal');
            }
            
            // Remove temporary directory
            try {
                tmpDir.removeCallback();
                console.log('✅ Removed temporary directory:', tmpDir.name);
                logger.info('Removed temporary directory:', tmpDir.name);
            } catch (tmpDirError) {
                console.error('❌ Error removing temporary directory:', tmpDirError);
                logger.error('Error removing temporary directory:', tmpDirError);
            }

            // Update status to completed only if no error occurred
            if (!processingError) {
                try {
                    const statusUpdateResponse = await axiosInstance({
                        method: 'post',
                        url: `${process.env.MAIN_SERVER_URL}/reels/internal/update`,
                        data: {
                            reelId: reelId,
                            video_proccessed_status: 'done'
                        },
                        timeout: 10000,
                        retryCount: 0
                    });
                    
                    console.log('✅ Status update sent successfully');
                    logger.info('Status update sent successfully');
                } catch (statusUpdateError) {
                    console.error('❌ Failed to update completion status:', statusUpdateError);
                    logger.error('Failed to update completion status:', statusUpdateError);
                }
            }

            console.log('=== Cleanup Process Completed ===\n');
        } catch (cleanupError) {
            console.error('\n❌ Error during cleanup:', cleanupError);
            console.error('Cleanup error details:', {
                name: cleanupError.name,
                message: cleanupError.message,
                stack: cleanupError.stack,
                code: cleanupError.code
            });
            
            logger.error('Error during cleanup:', cleanupError);
            logger.error('Cleanup error details:', {
                name: cleanupError.name,
                message: cleanupError.message,
                stack: cleanupError.stack,
                code: cleanupError.code
            });
        } finally {
            await logger.end();
        }
    }
}

async function createMasterPlaylist(basePath, outputPath, logger) {
    try {
        console.log('\n=== Creating Master Playlist ===');
        console.log(`Base Path: ${basePath}`);
        console.log(`Output Path: ${outputPath}`);

        const playlistContent = `#EXTM3U
#EXT-X-VERSION:3
${QUALITY_CONFIGS.map(config => {
    const bandwidth = (parseInt(config.videoBitrate) + parseInt(config.audioBitrate)) * 1000;
    return `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${config.maxHeight}x${config.maxHeight}
${config.name}/segments/playlist.m3u8`;
}).join('\n')}`;

        console.log('\nPlaylist content:');
        console.log(playlistContent);

        await fs.writeFile(outputPath, playlistContent);
        console.log('\n✅ Master playlist created successfully');
        
        if (logger) {
            logger.info('Master playlist created at:', outputPath);
            logger.info('Playlist content:', playlistContent);
        }
    } catch (error) {
        console.error('\n❌ Error creating master playlist:', error);
        if (logger) {
            logger.error('Error creating master playlist:', error);
        }
        throw error;
    }
}

async function uploadToS3(localPath, bucket, s3Path) {
    const logger = new Logger('s3-upload');
    await logger.initialize();
    
    try {
        console.log('\n=== Starting S3 Upload Process ===');
        console.log(`Local Path: ${localPath}`);
        console.log(`Bucket: ${bucket}`);
        console.log(`S3 Path: ${s3Path}\n`);

        // Verify AWS credentials
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            throw new Error('AWS credentials are not configured');
        }

        // Verify bucket exists
        try {
            await s3.headBucket({ Bucket: bucket });
            console.log(`✅ Bucket ${bucket} exists and is accessible`);
        } catch (error) {
            console.error(`❌ Error accessing bucket ${bucket}:`, error);
            throw new Error(`Cannot access bucket ${bucket}: ${error.message}`);
        }

        // Upload all files recursively
        const files = await fs.readdir(localPath, { recursive: true });
        console.log(`\n📁 Found ${files.length} files to upload:\n`);
        
        for (const file of files) {
            const localFilePath = path.join(localPath, file);
            const stats = await fs.stat(localFilePath);
            
            if (stats.isFile()) {
                const relativePath = path.relative(localPath, localFilePath);
                const s3Key = path.join(s3Path, relativePath).replace(/\\/g, '/');
                
                console.log(`\n📤 Uploading: ${file}`);
                // console.log(`   Local: ${localFilePath}`);
                // console.log(`   S3 Key: ${s3Key}`);
                // console.log(`   Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

                try {
                    const fileStream = fs.createReadStream(localFilePath);
                    
                    const upload = new Upload({
                        client: s3,
                        params: {
                            Bucket: bucket,
                            Key: s3Key,
                            Body: fileStream,
                            ContentType: getContentType(file),
                            ContentLength: stats.size
                        },
                        queueSize: 4,
                        partSize: 1024 * 1024 * 5,
                        leavePartsOnError: false
                    });

                    // Monitor upload progress
                    upload.on('httpUploadProgress', (progress) => {
                        const percentage = Math.round((progress.loaded / progress.total) * 100);
                        const loadedMB = (progress.loaded / (1024 * 1024)).toFixed(2);
                        const totalMB = (progress.total / (1024 * 1024)).toFixed(2);
                        process.stdout.write(`\r   Progress: ${percentage}% (${loadedMB}MB / ${totalMB}MB)`);
                    });

                    await upload.done();
                    console.log(`\n✅ Successfully uploaded: ${s3Key}`);
                } catch (uploadError) {
                    console.error(`\n❌ Failed to upload ${file}:`, uploadError);
                    throw new Error(`Failed to upload ${file}: ${uploadError.message}`);
                }
            }
        }

        console.log('\n=== Upload Process Completed ===\n');
        logger.success('All files uploaded successfully');
    } catch (error) {
        console.error('\n❌ S3 upload process failed:', error);
        logger.error('S3 upload process failed:', error);
        throw error;
    } finally {
        await logger.end();
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

export { processVideoToHLS }; 