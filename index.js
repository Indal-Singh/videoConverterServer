import dotenv from 'dotenv';
import express from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import videoQueue from './queue.js';
import worker from './worker.js';
import { S3 } from '@aws-sdk/client-s3';
import { processVideoToHLS } from './hlsVideoProcessor.js';
import { processVideoFromS3Url } from './videoProcessor.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON requests
app.use(express.json());

// Initialize S3 client
const s3 = new S3({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// AWS credentials check route
app.get('/aws/check', async (req, res) => {
    try {
        // Check if credentials are set
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            return res.status(400).json({
                success: false,
                error: 'AWS credentials are not configured',
                details: {
                    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ? 'Set' : 'Not set',
                    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'Not set',
                    AWS_REGION: process.env.AWS_REGION || 'Not set'
                }
            });
        }

        // Try to list buckets to verify credentials
        const buckets = await s3.listBuckets();
        
        return res.json({
            success: true,
            message: 'AWS credentials are valid',
            details: {
                region: process.env.AWS_REGION || 'us-east-1',
                buckets: buckets.Buckets.map(b => b.Name),
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID ? '***' + process.env.AWS_ACCESS_KEY_ID.slice(-4) : 'Not set',
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ? 'Set' : 'Not set'
                }
            }
        });
    } catch (error) {
        console.error('AWS credentials check failed:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to verify AWS credentials',
            message: error.message
        });
    }
});

app.post('/process-video', async (req, res) => {
    try {
      const { videoUrl } = req.body;
      
      if (!videoUrl) {
        return res.status(400).json({ error: 'Video URL is required' });
      }
      
      const processedUrl = await processVideoFromS3Url(videoUrl);
      
      return res.json({ 
        success: true, 
        originalUrl: videoUrl,
        processedUrl: processedUrl 
      });
    } catch (error) {
      console.error('Error in process-video route:', error);
      return res.status(500).json({ 
        error: 'Video processing failed', 
        message: error.message 
      });
    }
  });

// Setup Bull Board
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
    queues: [new BullMQAdapter(videoQueue)],
    serverAdapter
});

app.use('/admin/queues', serverAdapter.getRouter());

// roiute for create manual reel video processing without queue
app.post('/create-job/reels-processing-without-queue', async (req, res) => {
    try {
        const { reelId, videoUrl, folderPath } = req.body;
        const processedUrl = await processVideoToHLS(videoUrl, folderPath, reelId);
        return res.json({
            success: true,
            originalUrl: videoUrl,
            processedUrl: processedUrl
        });
    } catch (error) {
        console.error('Error creating job:', error);
    }
});


// Create job route
app.post('/create-job/reels-processing', async (req, res) => {
    try {
        const { reelId, videoUrl, folderPath } = req.body;

        if (!reelId || !videoUrl || !folderPath) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['reelId', 'videoUrl', 'folderPath']
            });
        }

        const job = await videoQueue.add('video-processing-reel', {
            reelId,
            videoUrl,
            folderPath,
            timestamp: Date.now()
        }, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 1000
            }
        });

        return res.json({
            success: true,
            message: 'Job created successfully',
            jobId: job.id,
            data: job.data
        });
    } catch (error) {
        console.error('Error creating job:', error);
        return res.status(500).json({
            error: 'Failed to create job',
            message: error.message
        });
    }
});

// Get job status route
app.get('/job-status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await videoQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const state = await job.getState();
        const progress = job.progress;
        const result = job.returnvalue;
        const failedReason = job.failedReason;

        return res.json({
            jobId,
            state,
            progress,
            result,
            failedReason
        });
    } catch (error) {
        console.error('Error getting job status:', error);
        return res.status(500).json({
            error: 'Failed to get job status',
            message: error.message
        });
    }
});

// List all jobs route
app.get('/jobs', async (req, res) => {
    try {
        const { status = 'all', limit = 100, offset = 0 } = req.query;
        
        let jobs = [];
        let total = 0;

        switch (status) {
            case 'active':
                jobs = await videoQueue.getActive();
                total = await videoQueue.getActiveCount();
                break;
            case 'waiting':
                jobs = await videoQueue.getWaiting();
                total = await videoQueue.getWaitingCount();
                break;
            case 'failed':
                jobs = await videoQueue.getFailed();
                total = await videoQueue.getFailedCount();
                break;
            case 'delayed':
                jobs = await videoQueue.getDelayed();
                total = await videoQueue.getDelayedCount();
                break;
            case 'completed':
                jobs = await videoQueue.getCompleted();
                total = await videoQueue.getCompletedCount();
                break;
            default:
                // Get jobs from all states
                const [active, waiting, failed, delayed, completed] = await Promise.all([
                    videoQueue.getActive(),
                    videoQueue.getWaiting(),
                    videoQueue.getFailed(),
                    videoQueue.getDelayed(),
                    videoQueue.getCompleted()
                ]);
                jobs = [...active, ...waiting, ...failed, ...delayed, ...completed];
                total = jobs.length;
        }

        // Sort jobs by timestamp (newest first)
        jobs.sort((a, b) => b.timestamp - a.timestamp);

        // Apply pagination
        const paginatedJobs = jobs.slice(offset, offset + limit);

        // Format job data
        const formattedJobs = await Promise.all(paginatedJobs.map(async (job) => {
            const state = await job.getState();
            return {
                id: job.id,
                name: job.name,
                data: job.data,
                state,
                progress: job.progress,
                timestamp: job.timestamp,
                processedOn: job.processedOn,
                finishedOn: job.finishedOn,
                failedReason: job.failedReason,
                returnvalue: job.returnvalue,
                attemptsMade: job.attemptsMade,
                attempts: job.opts.attempts
            };
        }));

        return res.json({
            total,
            limit: parseInt(limit),
            offset: parseInt(offset),
            jobs: formattedJobs
        });
    } catch (error) {
        console.error('Error listing jobs:', error);
        return res.status(500).json({
            error: 'Failed to list jobs',
            message: error.message
        });
    }
});

// Health check route
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Worker status check route
app.get('/worker/status', async (req, res) => {
    try {
        const isRunning = worker.isRunning();
        const [active, waiting, failed, delayed, completed] = await Promise.all([
            videoQueue.getActiveCount(),
            videoQueue.getWaitingCount(),
            videoQueue.getFailedCount(),
            videoQueue.getDelayedCount(),
            videoQueue.getCompletedCount()
        ]);

        return res.json({
            success: true,
            worker: {
                isRunning,
                status: isRunning ? 'active' : 'inactive',
                lastStatusCheck: new Date().toISOString()
            },
            queue: {
                active,
                waiting,
                failed,
                delayed,
                completed
            }
        });
    } catch (error) {
        console.error('Error checking worker status:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to check worker status',
            message: error.message
        });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bull Board available at http://localhost:${PORT}/admin/queues`);
});