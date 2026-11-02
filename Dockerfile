FROM python:3.11-slim@sha256:db20d8506e2f15b6db39b40b6015ca46bae855dec6dd326d462cfe79ae972893

WORKDIR /app

# 设置时区和语言环境
ENV TZ=Asia/Shanghai
ENV PYTHONUNBUFFERED=1

COPY backend/requirements.lock /app/backend/requirements.lock
RUN python -m pip install --no-cache-dir --upgrade pip==26.2.2 setuptools==84.2.1 \
    && pip install --no-cache-dir --require-hashes -r backend/requirements.lock

# Whitelist runtime files even if a deployment accidentally omits .dockerignore.
COPY backend /app/backend
COPY frontend /app/frontend
COPY package.json init_data.py update_use_cases.py /app/

EXPOSE 8088 8089

CMD ["python", "backend/main.py"]
