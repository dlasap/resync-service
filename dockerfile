FROM node:14-slim

RUN apt update;
RUN apt install git -y;
RUN npm install -g pm2;
RUN apt install g++ make python -y
RUN npm install ts-node@9 -g --save

WORKDIR /var/app
RUN mkdir /var/app/test
COPY ./package.json /var/app/package.json
COPY ./.npmrc /var/app/.npmrc
RUN npm cache clean -f
RUN  npm install
COPY ./ /var/app/
RUN npm run build


ENV GRPC_HOST 'localhost'
ENV GRPC_PORT '50051'
CMD [ "pm2-runtime","--name=resync-service","dist/main.js" ]