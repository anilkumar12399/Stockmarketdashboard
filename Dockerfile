# Use a Node.js runtime as a parent image
FROM node:18-slim

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy Python requirements file
COPY requirements.txt .

# Install Python dependencies
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy the rest of the application's code
COPY . .

# Expose the ports for Node.js and Python services
EXPOSE 3001 5000
