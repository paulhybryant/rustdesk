FROM docker.1ms.run/nginx:alpine

# Copy the prebuilt Flutter web application to the Nginx HTML directory
COPY build/web /usr/share/nginx/html

# Expose port 80 for HTTP traffic
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
