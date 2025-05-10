// credentials-test.js
// Run this file to test if your AWS credentials are properly configured
// Usage: node credentials-test.js

const { S3Client, ListBucketsCommand } = require("@aws-sdk/client-s3");
require('dotenv').config(); // Uncomment this if using a .env file

async function validateCredentials() {
    // Display current environment variables (partially masked for security)
    console.log("Environment variables:");
    console.log(`- AWS_REGION: ${process.env.AWS_REGION || 'not set'}`);
    console.log(`- AWS_ACCESS_KEY_ID: ${process.env.AWS_ACCESS_KEY_ID ? 
        '***' + process.env.AWS_ACCESS_KEY_ID.slice(-4) : 'not set'}`);
    console.log(`- AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY ? 
        '[Present but hidden]' : 'not set'}`);
    
    // Check for missing credentials
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        console.error("\n❌ ERROR: AWS credentials are missing!");
        console.log("\nPlease set your AWS credentials using one of these methods:");
        console.log("\n1. Environment variables:");
        console.log("   For Windows CMD:");
        console.log("   set AWS_ACCESS_KEY_ID=your_access_key_here");
        console.log("   set AWS_SECRET_ACCESS_KEY=your_secret_key_here");
        console.log("   set AWS_REGION=your_region_here");
        console.log("\n   For PowerShell:");
        console.log("   $env:AWS_ACCESS_KEY_ID=\"your_access_key_here\"");
        console.log("   $env:AWS_SECRET_ACCESS_KEY=\"your_secret_key_here\"");
        console.log("   $env:AWS_REGION=\"your_region_here\"");
        console.log("\n2. Using a .env file:");
        console.log("   Create a .env file with your credentials and install dotenv:");
        console.log("   npm install dotenv");
        console.log("   Then require it in your main file:");
        console.log("   require('dotenv').config();");
        return false;
    }
    
    console.log("\nCredentials found. Testing connection to AWS...");
    
    // Initialize the S3 client with the credentials
    const client = new S3Client({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });
    
    try {
        // Try to list buckets as a basic test
        console.log("Sending ListBuckets request to AWS...");
        const response = await client.send(new ListBucketsCommand({}));
        
        console.log("\n✅ SUCCESS! AWS credentials are valid.");
        console.log(`Found ${response.Buckets.length} bucket(s):`);
        response.Buckets.forEach(bucket => {
            console.log(`- ${bucket.Name}`);
        });
        
        return true;
    } catch (err) {
        console.error("\n❌ ERROR: Failed to authenticate with AWS");
        console.error("Error details:", err.message);
        
        if (err.message.includes("credentials")) {
            console.log("\nPossible issues:");
            console.log("1. Your access key or secret key is incorrect");
            console.log("2. Your IAM user doesn't have sufficient permissions");
            console.log("3. Your credentials have been rotated or revoked");
        }
        
        return false;
    }
}

// Run the validation
validateCredentials().then(isValid => {
    if (!isValid) {
        console.log("\nFor more help, see the AWS documentation:");
        console.log("https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html");
        process.exit(1);
    }
});