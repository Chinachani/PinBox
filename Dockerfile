FROM python:3.11-slim

WORKDIR /app

# 设置时区和语言环境
ENV TZ=Asia/Shanghai
ENV PYTHONUNBUFFERED=1

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    -r backend/requirements.txt

COPY . /app

EXPOSE 8088 8089

CMD ["python", "backend/main.py"]
