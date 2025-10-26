# Use an official Python runtime as a parent image
FROM node:24-slim

# Set the working directory in the container
WORKDIR /app

# Copy the requirements file into the container
COPY requirements.txt .

# Install PIP
RUN apt-get update && apt-get install -y python3 python3-pip

# Set the path to your virtual environment
ENV VENV_PATH=/opt/venv

# Create the virtual environment
RUN python3 -m venv $VENV_PATH

# Activate the venv and install packages
# Note: We activate it and run pip in the same RUN layer
RUN $VENV_PATH/bin/pip install --no-cache-dir -r requirements.txt

# Install Gemini CLI
RUN npm install -g @google/gemini-cli@nightly

# Copy the source code into the container
COPY src/ /app/src/

# Create a directory to mount local folders into
VOLUME /app/mounted_volume

# Set the default command to run when the container starts
CMD ["/opt/venv/bin/python", "-m src.telegcli.app"]