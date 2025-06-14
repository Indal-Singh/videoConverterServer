import { Queue } from 'bullmq';
import redisConfig from './config/redis.js';
import Logger from './utils/logger.js';

// Create a BullMQ queue for video processing
const videoQueue = new Queue('video-processing-reel', {
    connection: redisConfig,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000
        },
        removeOnComplete: true,
        removeOnFail: false
    }
});

// Initialize queue logger
const queueLogger = new Logger('queue');
queueLogger.initialize().then(() => {
    queueLogger.info('Queue logger initialized');
});

// Handle queue events
videoQueue.on('error', async (error) => {
    await queueLogger.error('Queue error:', error);
    await queueLogger.error('Error details:', {
        message: error.message,
        stack: error.stack
    });
});

videoQueue.on('failed', async (job, error) => {
    const jobLogger = new Logger(`job_${job.id}`);
    await jobLogger.initialize();
    await jobLogger.error(`Job failed:`, error);
    await jobLogger.error('Job data:', job.data);
    await jobLogger.end();
});

videoQueue.on('completed', async (job) => {
    const jobLogger = new Logger(`job_${job.id}`);
    await jobLogger.initialize();
    await jobLogger.success('Job completed successfully');
    await jobLogger.info('Job data:', job.data);
    await jobLogger.end();
});

// Add connection event handlers
videoQueue.on('ready', async () => {
    await queueLogger.success('Queue is ready and connected to Redis');
    await queueLogger.info('Queue name: video-processing-reel');
    
    // Log initial queue state
    const [active, waiting, failed, delayed, completed] = await Promise.all([
        videoQueue.getActiveCount(),
        videoQueue.getWaitingCount(),
        videoQueue.getFailedCount(),
        videoQueue.getDelayedCount(),
        videoQueue.getCompletedCount()
    ]);
    
    await queueLogger.info('Initial queue state:', {
        active,
        waiting,
        failed,
        delayed,
        completed
    });
});

videoQueue.on('disconnected', async () => {
    await queueLogger.error('Queue disconnected from Redis');
});

videoQueue.on('stalled', async (jobId) => {
    const jobLogger = new Logger(`job_${jobId}`);
    await jobLogger.initialize();
    await jobLogger.warn('Job has stalled');
    await jobLogger.end();
});

videoQueue.on('waiting', async (jobId) => {
    const jobLogger = new Logger(`job_${jobId}`);
    await jobLogger.initialize();
    
    // Get detailed job information
    const job = await videoQueue.getJob(jobId);
    if (job) {
        await jobLogger.info('Job is waiting to be processed', {
            jobId,
            data: job.data,
            timestamp: job.timestamp,
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn
        });
    } else {
        await jobLogger.warn(`Job ${jobId} not found in queue`);
    }
    
    // Log current queue state
    const [active, waiting, failed, delayed, completed] = await Promise.all([
        videoQueue.getActiveCount(),
        videoQueue.getWaitingCount(),
        videoQueue.getFailedCount(),
        videoQueue.getDelayedCount(),
        videoQueue.getCompletedCount()
    ]);
    
    await jobLogger.info('Current queue state:', {
        active,
        waiting,
        failed,
        delayed,
        completed
    });
    
    await jobLogger.end();
});

videoQueue.on('active', async (job) => {
    const jobLogger = new Logger(`job_${job.id}`);
    await jobLogger.initialize();
    await jobLogger.info('Job has started processing', {
        jobId: job.id,
        data: job.data,
        timestamp: job.timestamp,
        attemptsMade: job.attemptsMade
    });
    await jobLogger.end();
});

// Test the connection by getting the job counts
Promise.all([
    videoQueue.getActiveCount(),
    videoQueue.getWaitingCount(),
    videoQueue.getFailedCount(),
    videoQueue.getDelayedCount(),
    videoQueue.getCompletedCount()
]).then(async ([active, waiting, failed, delayed, completed]) => {
    await queueLogger.success('Queue connection test successful');
    await queueLogger.info('Current job counts:', {
        active,
        waiting,
        failed,
        delayed,
        completed
    });

    // If there are waiting jobs, log their details
    if (waiting > 0) {
        const waitingJobs = await videoQueue.getWaiting();
        await queueLogger.info('Waiting jobs details:', 
            waitingJobs.map(job => ({
                id: job.id,
                data: job.data,
                timestamp: job.timestamp,
                attemptsMade: job.attemptsMade
            }))
        );
    }
}).catch(async (error) => {
    await queueLogger.error('Queue connection test failed:', error);
    await queueLogger.error('Error details:', {
        message: error.message,
        stack: error.stack
    });
});

export default videoQueue; 