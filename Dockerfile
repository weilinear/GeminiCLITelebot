# Use an official Python runtime as a parent image
FROM node:20-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container
COPY requirements.txt .

# Install PIP
RUN apt-get update && apt-get install -y python3 python3-pip

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Install nodejs and npm
RUN apt-get update && apt-get install -y nodejs npm

# Install Gemini CLI
RUN npm install -g @google/gemini-cli@nightly

# Copy the source code into the container
COPY src/ /app/src/

# Create a directory to mount local folders into
VOLUME /app/mounted_volume

# Set the default command to run when the container starts
CMD ["python", "src/telegcli/app.py"]
