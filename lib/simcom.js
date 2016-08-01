var Modem = require('./modem.js');
var util = require('util'),
  Promise = require('bluebird'),
  pdu = require('pdu'),
  EventEmitter = require('events').EventEmitter;

var ipDetect = /\b(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;

var Connection = function (simcom, protocol, url, port) {
  var self = this;
  if(!(simcom instanceof SimCom)){
    this.emit('error');
    return;
  }

  this.simcom = simcom;
  this.protocol = protocol.toUpperCase();
  this.url = url;
  this.port = port;
  this.isConnected = false;
  this.isSending = false;
  this.buffer = [];

  this.on('connect', function (){
    this.buffer = [];
    self.isConnected = true;
    self.isConnecting = false;
    this.isSending = false;  
  })

  this.on('close', function (){
    self.isConnected = false;
    self.isConnecting = false; 
  });

  this.on('error', function (){
    self.isConnected = false;
    self.isConnecting = false; 
  });

  this.connect();

  EventEmitter.call(this);  
}

util.inherits(Connection, EventEmitter);

Connection.prototype.connect = function() {
  var self = this;
  this.isConnecting = true;
  this.simcom.connect(this.protocol, this.url, this.port).then(function(res){
    if(res.escape_char == 'CONNECT FAIL')
      throw new Error('CONNECT FAIL');
    else
      self.emit('connect');
  }).catch(function(error){
    self.emit('error', error);
  });
};

Connection.prototype.write = function(data) {
  var self = this;
  if(!Buffer.isBuffer(data))
    data = new Buffer(data + '|');
  else
    data = Buffer.concat([data, new Buffer('|')]);

  this.buffer.push(data);
  data = new Buffer(0);

  if(this.isSending){
    return;
  }
  
  if(this.isConnected && !this.isConnecting && this.buffer.length != 0){
    this.isSending = true;
    var length = 0;
    for (var i = 0; i < this.buffer.length; i++) {
      if(length > 300)
        break;
      data = Buffer.concat([this.buffer[i],data]);
      length +=this.buffer[i].length;
    };
    // data = Buffer.concat(this.buffer);
    this.buffer.splice(0, ++i);
    this.simcom.send(data).then(function(res){
      if(res.escape_char != 'SEND OK' /*'DATA ACCEPT:'+ data.length*/)
        // return self.simcom.networkStats();
      // else
        throw new Error('Connection is closed!');
   /* }).then(function(res){
      if(parseInt(res.txlen) == 0)
        return;

      if((res.txlen-res.acklen) != data.length){
        self.end();
        console.log('Data Transmit Error');
      }
        // self.emit('error', new Error('Data Transmit Error') );*/
    }).catch(function(e){
      self.emit('error', e);
    }).done(function(){
      self.isSending = false;
    });
  }
};

Connection.prototype.getData = function(data) {
  var self = this;
  this.simcom.getGPRSData().then(function(res){
    self.emit('data', res);
  });
};

Connection.prototype.end = function() {
  var self = this;
  if(!this.isConnected)
    return;

  this.simcom.disconnect().then(function(res){
    if(res.escape_char == 'ERROR')
      self.emit('error', new Error('Connection Close Error!'));
    else
      self.emit('close');
  });
};

Connection.prototype.reconnect = function() {
  if(this.isConnected)
    this.end();
  this.connect();
};

Connection.prototype.destroy = function() {
  this.end();
  delete this.simcom.connection;
  delete this.simcom;
};

function SimCom (device, options, cb) {
  var self = this;
	this.modem = new Modem();

	// delegates modem events
  ['open', 'error','idle', 'memory full', 'sms received', 'ring', 'end ring','connect', 'data', 'over-voltage warnning'].forEach(function(e) {
    this.modem.on(e, function() {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(e);
      self.emit.apply(self, args);
    });
  }.bind(this));

  this.modem.on('send fail', function(length){
    if(self.connection) 
      self.connection.end()
  });

  this.modem.on('gprs data', function(data){
    if(self.connection) 
      self.connection.emit('data', data);
  });

  this.modem.on('gprs close', function(length){
    if(self.connection) 
      self.connection.emit('close');
  });

  this.modem.open(device, options, cb);

  EventEmitter.call(this); 
}

util.inherits(SimCom, EventEmitter);

SimCom.prototype.close = function() {
  this.modem.close();
}

SimCom.prototype.execute = function() {
  var args = Array.prototype.slice.call(arguments);
  return this.modem.execute.apply(this.modem, args);
}

SimCom.prototype.queryGPRS = function() {
  var self = this;
  return this.execute('AT+CREG?;+CGATT?')
}

SimCom.prototype.shutGPRS = function() {
  return this.execute('AT+CIPSHUT', { timeout: 0, escape_char: 'SHUT OK'});
}

SimCom.prototype.startGPRS = function(apn) {
  var self = this;

  return self.shutGPRS().then(function(res){
      return self.queryGPRS();
  }).then(function(res){
    for (var i = 0; i < res.lines.length; i++) {
      var s = res.lines[i].replace(/\s+/g, '').split(':');
      if( (s[0] == '+CREG' && s[1] != '0,1') || (s[0] == '+CGATT' && s[1] != '1')){
        throw new Error('GPRS not ready!');
      }
    };

    return self.execute('AT+CIPRXGET=0;+CIPHEAD=1');
    // return true;
  }).then(function(res){
    if(typeof apn == 'undefined')
      throw new Error('APN is not set!');

    return self.execute('AT+CSTT="' +apn+ '"');
  }).then(function(res){
    return self.execute('AT+CIICR', {timeout: 0});
  }).then(function(res){
    if(res.escape_char == 'ERROR')
      throw new Error('GPRS Timeout!');

    return self.execute('AT+CIFSR', { escape_regexp: ipDetect } );
  }).then(function(res){
    return self.execute('AT+CIPQSEND=0');
  }).then(function(res){
    self.emit('gprs enabled');
  }).catch(function(error){
    self.emit('error', error);
  });
}

SimCom.prototype.createTCPConnection = function(url, port) {
  this.connection = new Connection(this, 'TCP', url, port);
  return this.connection;
}

SimCom.prototype.createUDPConnection = function(url, port) {
  this.connection = new Connection(this, 'UDP', url, port);
  return this.connection;
}

SimCom.prototype.connect = function(protocol, url, port) {
  return this.execute('AT+CIPSTART="' +protocol.toUpperCase()+ '","' +url+ '","' +port+ '"', { timeout: 30000,custom: true, escape_regexp: /^CONNECT/ });
}

SimCom.prototype.disconnect = function() {
  return this.execute('AT+CIPCLOSE', {escape_char: 'CLOSE OK'} );
}

SimCom.prototype.send = function(data) {
  var self = this;
  return this.execute('AT+CIPSEND=' +data.length, {special_command: true} ).then(function(res){
    if(res.escape_char == 'ERROR')
      throw new Error('Sending Error');

    return self.execute(data.toString(), {
      timeout: 10000,
      escape_func: function(res){
        if(res.trim() == 'SEND OK' /*'DATA ACCEPT:' + data.length*/)
          return true;
        else
          return false;
      }
    } );
  });
}

SimCom.prototype.networkStats = function() {
  return this.execute('AT+CIPACK').then(function(res){
    var s = res.lines[1].replace(/\s+/g, '').split(':')[1].split(',');
    var networkStats = {
      txlen: s[0],
      acklen: s[1],
      nacklen: s[2]
    }
    return networkStats;
  });
}

SimCom.prototype.getGPRSData = function() {
  return this.execute('AT+CIPRXGET=2,1460');
}

SimCom.prototype.enableGPS = function() {
  return this.execute('AT+CGNSPWR=1');
}

SimCom.prototype.disableGPS = function() {
  return this.execute('AT+CGNSPWR=0');
}

SimCom.prototype.startGPSINFO = function(interval) {
  var self = this;
  if(this.gpsInterval)
    this.stopGPSINFO();

  var getGPS = function(){
    if(self.connection && self.connection.isSending)
      return;

    self.execute('AT+CGNSINF').then(function(res){
      var s = res.lines[res.lines.length-1].replace(/\s+/g, '').split(':')[1].split(',');
      var year = s[2].substr(0, 4);
      var month = s[2].substr(4, 2)-1;
      var day = s[2].substr(6, 2);
      var hours = s[2].substr(8, 2);
      var minutes = s[2].substr(10, 2);
      var seconds = s[2].substr(12, 2);
      var milliseconds = s[2].substr(15, 3);
      var timestamp = Date.UTC(year, month, day, hours, minutes, seconds, milliseconds);
      var gps = {
        status: s[0],
        fix: s[1],
        lat: s[3],
        lng: s[4],
        alt: s[5],
        speed: s[6],
        heading: s[7],
        timestamp: timestamp
      }
      self.emit('gps', gps);
    })
  }
  getGPS();
  this.gpsInterval = setInterval(getGPS, interval || 5000);
}

SimCom.prototype.stopGPSINFO = function(interval) {
  var self = this;
  if(this.gpsInterval)
    clearInterval(this.gpsInterval);

  delete this.gpsInterval;
}

SimCom.prototype.checkSIM = function(interval) {
  var self = this;
  return this.execute('AT+CPIN?').then(function(res){
    if(res.escape_char == 'ERROR')
      self.emit('error', new Error('SIM NOT INSERTED'));

    var status = res.lines[res.lines.length-1].split(':')[1].trim();
    if(status != 'READY')
      self.emit('error', new Error('SIM NOT READY'));

    self.emit('ready');
  })
}

module.exports = SimCom;