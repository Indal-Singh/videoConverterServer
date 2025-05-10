# Use a lightweight Node.js image
FROM node:alpine

# Install ffmpeg
RUN apk update
RUN apk add --no-cache ffmpeg

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application files
COPY . .

# Expose the port the app runs on
EXPOSE 3020

# Command to run the application
CMD ["node", "index.js"]