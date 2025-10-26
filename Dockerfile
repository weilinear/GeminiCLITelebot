# 1. Start with an official Python image, which is smaller and has tools pre-installed.
FROM python:3.11-slim

# 2. Set the working directory.
WORKDIR /app

# 3. Copy only the requirements file first to leverage Docker's layer caching.
COPY requirements.txt .

# 4. Install dependencies directly. No venv needed.
#    The --no-cache-dir flag reduces image size.
RUN pip install --no-cache-dir -r requirements.txt

# (Optional) Install Gemini CLI if needed.
# Note: You'll need to install Node.js and npm first if you use a Python base image.
# If you don't need it, you can remove these lines.
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @google/gemini-cli@nightly && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 5. Copy your application code into the container.
COPY src/ /app/src/

# Create a directory to mount local folders into
VOLUME /app/mounted_volume

# 6. Set the command to run. This assumes you've added the __init__.py files (Recommended).
#    The python executable is already on the PATH.
CMD ["python", "-m", "src.telegcli.app"]