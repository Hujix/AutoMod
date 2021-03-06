import Statcord from 'statcord.js';
import { Logger } from 'logger';
import { Client, Structures } from 'discord.js';
import { envs } from '@/envs';

const log = new Logger({
  prefix: 'StatCord'
});

Structures.extend('GuildMember', GuildMember => {
  class CoolGuild extends GuildMember {
    pending = false;

    constructor(client: any, data: any, guild: any) {
      super(client, data, guild);
      this.pending = data.pending ?? false;
    }

    _patch(data: any) {
      // @ts-expect-error
      super._patch(data);
      this.pending = data.pending ?? false;
    }
  }

  return CoolGuild;
});

export const client = new Client();

// Create statcord client
export const statcord = new Statcord.Client({
  client,
  key: envs.STATCORD.API_KEY,
  postCpuStatistics: envs.STATCORD.CPU_STATS, /* Whether to post memory statistics or not, defaults to true */
  postMemStatistics: envs.STATCORD.MEMORY_STATS, /* Whether to post memory statistics or not, defaults to true */
  postNetworkStatistics: envs.STATCORD.NETWORK_STATS, /* Whether to post memory statistics or not, defaults to true */
});

statcord.on('autopost-start', () => {
  // Emitted when statcord autopost starts
  log.info('Started autopost');
});

statcord.on('post', status => {
  if (!status) log.info('Posted status');
  else log.error(status as Error);
});
