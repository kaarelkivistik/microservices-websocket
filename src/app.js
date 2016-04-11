import querystring from 'querystring';
import { Server } from 'ws';
import amqplib from 'amqplib';

const { 
	DEBUG,
	MESSAGES_WEBSOCKET_SERVICE_PORT = "80", 
	MESSAGES_RABBIT_SERVICE_HOST = "localhost", 
	MESSAGES_RABBIT_SERVICE_PORT = 5672, 
	MESSAGES_EXCHANGE_NAME = "messages" } = process.env;

const wss = new Server({
	port: MESSAGES_WEBSOCKET_SERVICE_PORT
});

let connections = {};

amqplib.connect("amqp://" + MESSAGES_RABBIT_SERVICE_HOST + ":" + MESSAGES_RABBIT_SERVICE_PORT).then(rabbit => {
	rabbit.createChannel().then(channel => {
		wss.on("connection", socket => {
			const { url } = socket.upgradeReq;
			const queryParameters = querystring.parse(url.substr(2));
			const { name } = queryParameters;
			
			let consumerTag;
			
			if(DEBUG)
				console.log("Client connected: %s", name);
			
			connections[name] = socket;
			
			channel.assertExchange(MESSAGES_EXCHANGE_NAME, "topic", {
				durable: true
			}).then(() => {
				socket.on("message", data => {
					try {
						const decoded = JSON.parse(data);
						
						const { type } = decoded;
						
						let forwardedMessage;
						
						switch(type) {
							case "MESSAGE_SENT":
								const { message: { to, text } } = decoded;
								
								forwardedMessage = {
									type: "MESSAGE_SENT",
									message: {
										from: name, text
									}
								};
								
								break;
								
							case "CONVERSATION_CREATED":
								const { conversation: { id, participants } } = decoded;
								
								forwardedMessage = {
									type: "CONVERSATION_CREATED",
									conversation: {
										id, participants
									}
								};
								
								break;
						}
						
						if(DEBUG)
							console.log("to queue", forwardedMessage);
						
						channel.publish(MESSAGES_EXCHANGE_NAME, to, new Buffer(JSON.stringify(forwardedMessage)));
					} catch (exception) {
						if(DEBUG)
							console.error("Garbled message from user %s.", name, exception);
					}
				});
			});
			
			channel.assertQueue(name, {
				autoDelete: true
			}).then(queue => {
				channel.bindQueue(name, MESSAGES_EXCHANGE_NAME, name).then(() => {
					channel.consume(name, message => {
						try {
							const decoded = JSON.parse(message.content.toString());
							
							const { type } = decoded;
							
							let forwardedMessage;
							
							switch(type) {
								case "MESSAGE_SENT":
									const { message: { from, text } } = decoded;
									
									forwardedMessage = {
										type: "MESSAGE_SENT",
										message: {
											from, text
										}
									};
									
									break;
									
								case "CONVERSATION_CREATED":
									const { conversation: { id, participants } } = decoded;
									
									forwardedMessage = {
										type: "CONVERSATION_CREATED",
										conversation: {
											id, participants
										}
									};
									
									break;
							}
							
							if(DEBUG)
								console.log("to socket", forwardedMessage);
														
							connections[name].send(JSON.stringify(forwardedMessage));						
						} catch(exception) {
							if(DEBUG)
								console.error("Garbled message from queue.", exception);
						}
						
						channel.ack(message);
					}).then(response => {
						consumerTag = response.consumerTag;
					});
				});
				
				socket.on("close", () => {
					if(consumerTag)
						channel.cancel(consumerTag);
					
					delete connections[name];
				});	
			});
		});
	});	
});

console.log("messages-websocket service started");
console.log("  PID=%s", process.pid);
console.log("  DEBUG=%s", DEBUG);
console.log("  MESSAGES_WEBSOCKET_SERVICE_PORT=%s", MESSAGES_WEBSOCKET_SERVICE_PORT);
console.log("  MESSAGES_RABBIT_SERVICE_HOST=%s", MESSAGES_RABBIT_SERVICE_HOST);
console.log("  MESSAGES_RABBIT_SERVICE_PORT=%s", MESSAGES_RABBIT_SERVICE_PORT);
console.log("  MESSAGES_EXCHANGE_NAME=%s", MESSAGES_EXCHANGE_NAME);
console.log("\n");

function exitOnSignal(signal) {
	process.on(signal, function() {
		console.log("Shutting down.. (%s)", signal);
		
		process.exit(0);
	});
}

exitOnSignal("SIGTERM");
exitOnSignal("SIGINT");