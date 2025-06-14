import { Worker } from 'bullmq';
import redisConfig from './config/redis.js';
import { processVideoToHLS } from './hlsVideoProcessor.js';
import Logger from './utils/logger.js';

// Initialize worker logger
const workerLogger = new Logger('worker');
workerLogger.initialize().then(() => {
    workerLogger.info('Worker logger initialized');
});

// Create worker for processing jobs
const worker = new Worker('video-processing-reel', async (job) => {
    const logger = new Logger(`worker_${job.id}`);
    await logger.initialize();

    try {
        logger.info('Received job:', job.id);
        logger.info('Raw job data:', job.data);

        // Handle different job data formats
        let reelId, videoUrl, folderPath;

        if (job.data.data) {
            // Laravel format
            const laravelData = job.data.data;
            reelId = laravelData.reelId;
            videoUrl = laravelData.videoUrl;
            folderPath = laravelData.folderPath;
        } else if (job.data.command) {
            // Laravel serialized format
            const command = job.data.command;
            reelId = command.reelId;
            videoUrl = command.videoUrl;
            folderPath = command.folderPath;
        } else {
            // BullMQ format
            reelId = job.data.reelId;
            videoUrl = job.data.videoUrl;
            folderPath = job.data.folderPath;
        }

        // Validate required fields
        if (!reelId || !videoUrl || !folderPath) {
            const error = new Error('Missing required fields in job data');
            logger.error('Job data validation failed:', {
                reelId,
                videoUrl,
                folderPath,
                rawData: job.data
            });
            throw error;
        }

        logger.info(`Starting video processing job for reel ${reelId}`);
        logger.info(`Video URL: ${videoUrl}`);
        logger.info(`Folder Path: ${folderPath}`);

        // Process the video using our existing function
        const result = await processVideoToHLS(videoUrl, folderPath, reelId);
        
        logger.success(`Video processing completed for reel ${reelId}`);
        logger.info('Processing results:', result);
        
        return {
            success: true,
            reelId,
            result
        };
    } catch (error) {
        logger.error(`Error processing job ${job.id}:`, error);
        logger.error('Job data:', job.data);
        throw error;
    } finally {
        await logger.end();
    }
}, {
    connection: redisConfig,
    concurrency: 1 // change if you want to proccess more at same time 
});

// Handle worker events
worker.on('error', async (error) => {
    await workerLogger.error('Worker error:', error);
    await workerLogger.error('Error details:', {
        message: error.message,
        stack: error.stack
    });
});

worker.on('failed', async (job, error) => {
    const logger = new Logger(`worker_failed_${job.id}`);
    await logger.initialize();
    await logger.error(`Job ${job.id} failed:`, error);
    await logger.error('Job data:', job.data);
    await logger.end();
});

worker.on('completed', async (job) => {
    const logger = new Logger(`worker_completed_${job.id}`);
    await logger.initialize();
    await logger.success(`Job ${job.id} completed successfully`);
    await logger.info('Job data:', job.data);
    await logger.end();
});

worker.on('stalled', async (jobId) => {
    const logger = new Logger(`worker_stalled_${jobId}`);
    await logger.initialize();
    await logger.warn(`Job ${jobId} has stalled`);
    await logger.end();
});

worker.on('ready', async () => {
    await workerLogger.success('Worker is ready to process jobs');
    await workerLogger.info('Worker configuration:', {
        queueName: 'video-processing-reel',
        concurrency: 1,
        connection: {
            host: redisConfig.host,
            port: redisConfig.port
        }
    });
});

worker.on('closed', async () => {
    await workerLogger.warn('Worker has been closed');
});

// Log worker status periodically
setInterval(async () => {
    try {
        const isRunning = worker.isRunning();
        await workerLogger.info('Worker status check:', {
            isRunning,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        await workerLogger.error('Error checking worker status:', error);
    }
}, 30000); // Check every 30 seconds

export default worker; 