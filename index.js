const express = require('express');
require('dotenv').config(); // Load environment variables (if using .env file)
const { processVideoFromS3Url } = require('./videoProcessor'); // Update the path
const { processVideoToHLS } = require('./hlsVideoProcessor');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON requests
app.use(express.json());

// Basic route
app.get('/', (req, res) => {
  res.send('Welcome to the Video Converter Server!');
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



app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// mpd processor route
app.post('/process-m3u8-videos', async (req, res) => {
  try {
    const { videoUrl, folderPath ,reelId } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'Video File is required' });
    }

    if (!folderPath) {
      return res.status(400).json({ error: 'Folder path is required' });
    }

    const processedUrl = await processVideoToHLS(videoUrl, folderPath,reelId);
    
   console.log('Received request to process HLS videos:', req.body);
    return res.json({
      success: true,
      originalUrl: videoUrl,
      processedUrl: processedUrl
    });
  } catch (error) {
    console.error('Error in process-m3u8 route:', error);
    return res.status(500).json({ 
      error: 'HLS processing failed', 
      message: error.message 
    });
  }
});


// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
