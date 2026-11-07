FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 IM_DATA_DIR=/data
COPY requirements.txt requirements.lock.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt && useradd --uid 10001 --create-home im && mkdir /data && chown im:im /data
COPY server ./server
COPY client ./client
USER im
VOLUME ["/data"]
EXPOSE 18200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:18200/api/health', timeout=3)"
CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "18200", "--workers", "1", "--no-access-log"]
