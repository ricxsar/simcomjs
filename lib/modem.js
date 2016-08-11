var pdu = require('pdu');
var sp = require('serialport');
var Promise = require('bluebird');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var Modem = function(){
  this.queue = []; //Holds queue of commands to be executed.
  this.isLocked = false; //Device status
  this.partials = {}; //List of stored partial messages
  this.isOpened = false;
  this.job_id = 1;
  this.ussd_pdu = true; //Should USSD queries be done in PDU mode?

  //For each job, there will be a timeout stored here. We cant store timeout in item's themselves because timeout's are
  //circular objects and we want to JSON them to send them over sock.io which would be problematic.
  this.timeouts = {};

  EventEmitter.call(this); 
}

util.inherits(Modem, EventEmitter);

//Lock the device and null the data buffer for this command.
Modem.prototype.open = function(device, options, cb) {
  var self = this;

  options.parser = sp.parsers.readline('\r');
  self.port = new sp(device, options);

  self.port.on('open', function() {
    self.isOpened = true;

    self.port.on('data', self.dataReceived.bind(self));

    self.execute('AT')
    .then(function(data){
      self.emit('open');
      if(cb)
          cb();
    })
    .catch(function(e){
      console.log('modem error:', e);
      if(cb)
          cb(e);
    });
  });

  self.port.on('close', function() {
    self.port.close();
    self.isOpened = false;
    self.emit('close');
  });

  self.port.on('error', function() {
    self.close();
  });
}

Modem.prototype.execute = function(command, options) {
  if(!this.isOpened) {
    this.emit('close');
    return ;
  }

  var item = Promise.pending();

  item.escape_func = function(){
      return false;
  }

  item.escape_regexp = /$a/; 
  item.escape_char = /$a/; 
  item.timeout = 5000;

  if(options){
    for (var optionKey in options)
        item[optionKey] = options[optionKey];
  }

  item.command = command;
  item.id = ++this.job_id;

  this.queue.push(item);

  process.nextTick(this.executeNext.bind(this));
  return item.promise;
};

Modem.prototype.executeNext = function() {
  if(!this.isOpened) {
    this.emit('close');
    return ;
  }
  //Someone else is running. Wait.
  if(this.isLocked)
    return ; 

  var item = this.queue[0];

  if(!item) {
    this.emit('idle');
    return ; //Queue is empty.
  }

  this.data = '';
  this.isLocked = true;

  item.execute_time = new Date();

  if(item.timeout)
    this.timeouts[item.id] = setTimeout(function() {
        item.reject( new Error('Command Timeout!') );
        this.release();
        this.executeNext();
    }.bind(this), item.timeout);

  this.port.write(item['command']+"\r");

  // console.log('command:', item.command);
  if( item.special_command ){
    clearTimeout(this.timeouts[item.id]);
    this.timeouts[item.id] = setTimeout(function() {
        item.resolve({
          command: item.command,
          lines: [],
          escape_char: '>'
        });
        this.release();
        this.executeNext();
    }.bind(this), 2000);
  }
};


Modem.prototype.close = function(device) {
  this.port.removeAllListeners();
  this.port.close();
  this.port = null;
  this.isOpened = false;
  this.emit('close');
}

Modem.prototype.dataReceived = function(data) {

  /*var datas = buffer.trim().split('\r');

  datas.forEach(function(data) {*/
    var item = this.queue[0];
    // When we write to modem, it gets echoed.
    // Filter out queue we just executed.
    if(item && item['command'].trim().slice(0, data.length) === data) {
      return ;
    }

    //Emit received data for those who care.
    this.emit('data', data);

    if(data.trim().slice(0,4).trim() === '+IPD') {
      console.log('+IPD', data.trim() );
      this.emit('gprs data', data.split(':')[1].trim() );
      return ;
    }

    if(data.trim().slice(0,9).trim() === 'SEND FAIL') {
      this.emit('send fail');
      return ;
    }

    if(data.trim().slice(0,6).trim() === 'CLOSED') {
      this.emit('gprs close');
      return ;
    }

    if(data.trim().slice(0,5).trim() === '+CMTI') {
      this.smsReceived(data);
      return ;
    }

    if(data.trim().slice(0,5).trim() === '+CDSI') {
      this.deliveryReceived(data);
      return ;
    }

    if(data.trim().slice(0,5).trim() === '+CLIP') {
      this.ring(data);
      return ;
    }

    if(data.trim().slice(0,10).trim() === '^SMMEMFULL') {
      modem.emit('memory full', modem.parseResponse(data)[0]);
      return ;
    }

    //We are expecting results to a command. Modem, at the same time, is notifying us (of something).
    //Filter out modem's notification. Its not our response.
    if(item && data.trim().substr(0,1) === '^')
      return ;

    this.data += data;

    var delimiter = '';

    var lines = this.data.trim().split('\n');
    lines = lines.filter(function(n){ return n != '' });

    if(lines.length > 0){
      delimiter = lines[lines.length-1].trim();
    }

    if(typeof item === 'undefined')
      return;

    // console.log('modem:', delimiter, item.escape_char);

    if(item.custom){
      if(delimiter == item.escape_char || item.escape_func(delimiter) ||  item.escape_regexp.test(delimiter)){

        var escape_char = delimiter;        

        clearTimeout(this.timeouts[item.id]);

        lines.pop(); // remove delimiter fem lines of data

        // resolve promise
        item.resolve({
          command: item.command,
          lines: lines,
          escape_char: escape_char
        })

        this.release();

        this.executeNext();
        return;
      }
      return;
    }

    if(delimiter === 'OK' || delimiter.match(/error/i) || delimiter == item.escape_char || item.escape_func(delimiter) ||  item.escape_regexp.test(delimiter)) { //Command finished running.

      var escape_char = delimiter;

      
      // Ordering of the following lines is important.
      // First, we should release the modem. That will remove the current running item from queue.
      // Then, we should call the callback. It might add another item with priority which will be added at the top of the queue.
      // Then executeNext will execute the next command.
      

      clearTimeout(this.timeouts[item.id]);

      lines.pop(); // remove delimiter fem lines of data

      // resolve promise
      item.resolve({
        command: item.command,
        lines: lines,
        escape_char: escape_char
      })

      this.release();

      this.executeNext();

      return;
    }
  // }.bind(this));
}

Modem.prototype.release = function() {
  this.data = ''; //Empty the result buffer.
  this.isLocked = false; //release the modem for next command.
  this.queue.shift(); //Remove current item from queue.
}

Modem.prototype.getMessages = function() {
    return this.execute('AT+CMGL=1')
    .then(function(data) {
        var messages = [];
        var i = 0;
        data.lines.forEach(function(line) {
            if(line.trim().length === 0)
                return;

            if(line.slice(0,1) === '+') {
                i = this.parseResponse(line)[0];
                return ;
            }

            var message = this.processReceivedPdu(line, i);
            if(message)
                messages.push(message);
        }.bind(this));

        return messages;

    }.bind(this));
}

Modem.prototype.processReceivedPdu = function(pduString, index) {
  try {
    var message = pdu.parse(pduString);
    message.text = message.text.replace(/^\0+/, '').replace(/\0+$/, '');
  } catch(error) {
    return ;
  }
  message['indexes'] = [index];

  if(typeof(message['udh']) === 'undefined') //Messages has no data-header and therefore, is not contatenated.
    return message;

  if(message['udh']['iei'] !== '00' && message['udh']['iei'] !== '08') //Message has some data-header, but its not a contatenated message;
    return message;

  var messagesId = message.sender+'_'+message.udh.reference_number;
  if(typeof(this.partials[messagesId]) === 'undefined')
    this.partials[messagesId] = [];

  this.partials[messagesId].push(message);
  if(this.partials[messagesId].length < message.udh.parts)
    return ;

  var text = '';
  var indexes = [];

  for(var i = 0; i<message.udh.parts;i++)
    for(var j = 0; j<message.udh.parts;j++)
      if(this.partials[messagesId][j].udh.current_part === i+1) {
        text += this.partials[messagesId][j].text;
        indexes.push(this.partials[messagesId][j].indexes[0]);
        continue ;
      }
  message['text'] = text; //Update text.
  message['indexes'] = indexes; //Update idex list.

  delete this.partials[messagesId]; //Remove from partials list.

  return message;
}

Modem.prototype.parseResponse = function(response) {
  var plain = response.slice(response.indexOf(':')+1).trim();
  var parts = plain.split(/,(?=(?:[^"]|"[^"]*")*$)/);
  for(i in parts)
    parts[i] = parts[i].replace(/\"/g, '');

  return parts;
}

Modem.prototype.ring = function(data) {
  var clip = this.parseResponse(data);
  this.emit('ring', clip[0]);
}

Modem.prototype.deliveryReceived = function(delivery) {
  var response = this.parseResponse(delivery);
  this.execute('AT+CPMS="'+response[0]+'"')
  .then(function(){
    return this.execute('AT+CMGR='+response[1]);
  })
  .then(function(cmgr) {
      var lines = cmgr.trim().split("\n");
      var deliveryResponse = pdu.parseStatusReport(lines[1]);
      this.emit('delivery', deliveryResponse, response[1]);
  }.bind(this));
}

Modem.prototype.smsReceived = function(cmti) {
  var message_info = this.parseResponse(cmti);
  var memory = message_info[0];
  this.execute('AT+CPMS="'+memory+'"')
  .then(function(memory_usage) {
    var memory_usage = modem.parseResponse(memory_usage);
    var used  = parseInt(memory_usage[0]);
    var total = parseInt(memory_usage[1]);

    if(used === total)
      this.emit('memory full', memory);
  }.bind(this));

  this.execute('AT+CMGR='+message_info[1])
  .then(function(cmgr) {
    var lines = cmgr.trim().split("\n");
    var message = this.processReceivedPdu(lines[1], message_info[1]);
    if(message)
      this.emit('sms received', message);
  }.bind(this));
}

module.exports = Modem;


