import { sql } from '@databases/pg';
import { DMChannel, GuildMember, Interaction, Message, MessageEmbed, NewsChannel, TextChannel } from 'discord.js';
import { Command } from './command';
import { PromiseValue } from 'type-fest';
import { database } from './database';
import { RateLimiter } from 'discord.js-rate-limiter';
import { envs } from './envs';
import {
    AppError,
    CommandPermissionError,
    InvalidCommandError,
} from './errors';
import { isTextChannelMessage } from './guards';
import { LevelManager } from './levels';
import { log } from './log';
import { moduleManager } from './module-manager';
import { Server } from './servers';
import { promiseTimeout } from './utils';
import { statcord } from '@/client';

interface UserOptions {
    id: string;
    displayName: string;
    displayImage: string;
    serverId: string;
    experience: number;
    messages: number;
};

// In milliseconds
const FIVE_SECONDS = 5000;

const rateLimiterUser = new RateLimiter(1, FIVE_SECONDS);
const rateLimiterMessage = new RateLimiter(1, FIVE_SECONDS);

export class User {
    public id: string;
    public displayName: string;
    public displayImage: string;
    public serverId: string;
    public experience = 0;
    public messages = 0;

    constructor(options: Partial<UserOptions> & { id: User['id'], serverId: User['serverId'] }) {
        this.id = options.id;
        // serverId is the correct field
        // serverid is returned from the database
        this.serverId = options.serverId ?? (options as any).serverid;
        // displayName is the correct field
        // displayname is returned from the database
        this.displayName = options.displayName ?? (options as any).displayname;
        // displayImage is the correct field
        // displayimage is returned from the database
        this.displayImage = options.displayImage ?? (options as any).displayimage;
        this.experience = Number(options.experience) ?? 0;
        this.messages = Number(options.messages) ?? 0;
    }

    private static async _findAll({ id }: { id: User['id'] }) {
        const users = await database.query<User>(sql`SELECT * FROM users WHERE id=${id};`);

        // Return existing user
        return users.map(user => new User(user));
    }

    public static async find({ id, serverId, }: { id: User['id'], serverId?: Server['id'], }) {
        // Get specific user instance
        if (serverId) {
            const users = await database.query<User>(sql`SELECT * FROM users WHERE serverId=${serverId} AND id=${id};`);

            // No user found
            if (users.length === 1) {
                return;
            }

            // Return existing user
            return [new User(users[0])];
        }

        return this._findAll({ id });
    }

    public static async findOrCreate({ id, }: { id: User['id'], }): Promise<User[]>;
    public static async findOrCreate({ id, serverId, }: { id: User['id'], serverId?: Server['id'], }): Promise<User>;
    public static async findOrCreate({ id, serverId, }: { id: User['id'], serverId?: Server['id'], }) {
        // Get specific user instance
        if (serverId) {
            const users = await database.query<User>(sql`SELECT * FROM users WHERE serverId=${serverId} AND id=${id};`);

            // No user found
            if (users.length === 0) {
                return this.create({ serverId, id });
            }

            // Return existing user
            return new User(users[0]);
        }

        return this._findAll({ id });
    }

    public static async create({ serverId, id }: { serverId: Server['id'], id: User['id'] }) {
        try {
            // Create user
            const experience = 0;
            await database.query(sql`INSERT INTO users(serverId,id,experience) VALUES (${serverId},${id},${experience});`);

            // Failed to create user
            const users = await database.query<User>(sql`SELECT * FROM users WHERE serverId=${serverId} AND id=${id};`);
            if (users.length === 0) {
                throw new AppError(`Failed to create user ${id}`);
            }

            // Return new user
            return new User(users[0]);
        } catch (error) {
            throw new AppError(`Failed to create user ${id} in ${serverId}`);
        }
    }

    public async addExperience(experience: number) {
        log.debug(`Adding ${experience} experience to ${this.id}`);

        // Update local cache
        this.experience += experience;
        // Update database
        await database.query<User>(sql`UPDATE users SET experience=experience+${experience} WHERE serverId=${this.serverId} AND id=${this.id}`);
    }

    public async resetExperience() {
        // Update local cache
        this.experience = 0;
        // Update database
        await database.query<User>(sql`UPDATE users SET experience=0 WHERE id=${this.id}`);
    }

    get level() {
        return LevelManager.ExperienceToLevel(this.experience);
    }

    public async setDisplayName(displayName?: string) {
        if (displayName) {
            if (!this.displayName || this.displayName !== displayName) {
                // Update local cache
                this.displayName = displayName;

                // Update database
                await database.query<User>(sql`UPDATE users SET displayName=${displayName} WHERE serverId=${this.serverId} AND id=${this.id}`);
            }
        }
    }

    public async setDisplayImage(displayImage?: string) {
        if (displayImage) {
            if (!this.displayImage || this.displayImage !== displayImage) {
                // Update local cache
                this.displayImage = displayImage;

                // Update database
                await database.query<User>(sql`UPDATE users SET displayImage=${displayImage} WHERE serverId=${this.serverId} AND id=${this.id}`);
            }
        }
    }

    public async processVerifications(message: Message) {
        const channelId = message.channel.id;
        // Is this a verification channel?
        // Is the command enabled?
        const verificationChannels = await database.query(sql`SELECT * FROM verifications WHERE enabled=true AND allowedChannels @> ARRAY[${channelId}]::varchar[]`);
        console.log({ verificationChannels });

        // Do we require a profile image?


        // Did the user succeed?
        // Did the user fail?
        // Did the user cause an error?
    }

    private async processCommand(message: Message | Interaction) {
        // Get current server
        const server = await Server.findOrCreate({ id: this.serverId });

        // Skip messages without our prefix
        if (!message.content.startsWith(server.prefix)) return;

        // Silence the output
        let silent = false;
        if (message.content.startsWith(server.prefix + '$')) {
            // Enable silent mode
            silent = true;
        }

        // Log full message
        log.debug(`[${message.author?.tag}]: ${message.content}`);

        const commandBody = message.content.slice(silent ? server.prefix.length + 1 : server.prefix.length);
        const args = commandBody.split(' ');
        const commandName = args.shift()?.toLowerCase()?.trim();

        try {
            // Bail if there's no command given
            if (!commandName) {
                return;
            }

            // Check if user is rate limited
            const limited = rateLimiterUser.take(`${message.author!.id}_${commandName}`);
            if (limited) {
                // Only send rate limit message once every n seconds
                const canSendMessage = !rateLimiterMessage.take(`${message.author!.id}_${commandName}`);
                if (!canSendMessage) return;
                await message.channel.send(new MessageEmbed({
                    author: {
                        name: 'Rate Limited!'
                    },
                    description: `You're trying to run this command too often, try again in 5s.`
                }))
                return;
            }

            // Bail if the command isn't valid
            const command = moduleManager.getCommand(commandName);
            if (!command) {
                // Skip error on production
                // This allows other bots to use the same prefix
                if (envs.NODE_ENV === 'production') return;
                throw new InvalidCommandError(server.prefix, commandName, args);
            }

            // Check we have permission to proceed
            await this.processPermissions(commandName, server, message.member!, command);

            // Let statcord know we used a command
            await statcord.postCommand(command.command, message.author!.id);

            // Ensure we have all the needed options
            const options = command.options.filter(option => option.required);
            if (options.length >= 1) {
                // Not enough arguments
                if (args.length < options.length) {
                    throw new AppError('Not enough args, %s requires at least %s args.', command.name, options.length);
                }
            }

            // Run the command
            const commandPromise = Promise.resolve(command.messageHandler ? command.messageHandler(server.prefix, message as Message, args) : command.handler(server.prefix, message, args));
            const result = await promiseTimeout(commandPromise, command.timeout ?? FIVE_SECONDS);

            await this.processResult(result, message.channel, message.member!);
        } catch (error) {
            const appError = new AppError(error);
            await message.channel.send(appError.toEmbed());
        }
    }

    public async processInteraction(interaction: Interaction) {
        // Get current server
        const server = await Server.findOrCreate({ id: this.serverId });

        // Get command
        const commandName = interaction.name;
        const command = moduleManager.getCommand(commandName);

        // Check we have permission to proceed
        await this.processPermissions(interaction.name, server, interaction.member!, command);

        // Process command
        return command?.interactionHandler(server.prefix, interaction);
    }

    public async processPermissions(commandName: string, server: Server, member: GuildMember, command?: Command) {
        // Command isn't loaded
        if (!command) {
            throw new AppError(`\`${commandName}\` is currently unloaded!`);
        }

        // Is command enabled?
        if (await command.isEnabled(server.id).then(enabled => !enabled)) {
            // Command is disabled, bail
            throw new AppError(`The \`${commandName}\` command is disabled!`);
        }

        // Skip checks as they're the owner
        if (member.id === member.guild.owner?.id) {
            return;
        }

        // If the command needs permissions lets check them
        if (command?.permissions.length >= 1) {
            // Check we have Discord permissions to run this
            if (!command?.permissions.some(permission => member?.hasPermission(permission as any))) {
                throw new CommandPermissionError(server.prefix, commandName);
            }
        }

        // Has a denied role
        const deniedRoles = await command.getDeniedRoles(server.id);
        const isDenied = deniedRoles.some(deniedRole => member.roles.cache.find(role => {
            const nameMatches = role.name.toLowerCase() === deniedRole.toLowerCase();
            const idMatches = role.id === deniedRole;
            return idMatches || nameMatches;
        }));
        if (isDenied) {
            throw new AppError(`You don't have permission to use \`${commandName}\`!`);
        }

        // Has an allowed role
        const allowedRoles = await command.getAllowedRoles(server.id);
        const anyoneCanUse = allowedRoles.length === 1 && allowedRoles[0] === '*';
        const isAllowed = anyoneCanUse || allowedRoles.some(allowedRole => member.roles.cache.find(role => {
            const nameMatches = role.name.toLowerCase() === allowedRole.toLowerCase();
            const idMatches = role.id === allowedRole;
            return idMatches || nameMatches;
        }));
        if (!isAllowed) {
            throw new AppError(`You don't have permission to use \`${commandName}\`!`);
        }
    }

    public async processMessage(message: Message) {
        // Non text channel
        if (!isTextChannelMessage(message)) {
            return;
        }

        // Update our cache with the user's display name
        await this.setDisplayName(message.guild?.members.cache.get(this.id)?.displayName || message.guild?.members.cache.get(this.id)?.user.username);

        // Update our cache with the user's display image
        await this.setDisplayImage(message.guild?.members.cache.get(this.id)?.user.displayAvatarURL({ format: 'png' }));

        // Process command
        await this.processCommand(message);
    }

    async processResult(result: PromiseValue<ReturnType<User['processMessage'] | User['processInteraction']>>, channel: TextChannel | NewsChannel | DMChannel, member: GuildMember) {
        try {
            // No output
            if (!result) {
                throw new AppError('No command output');
            }

            // Output is a string and starts with a capital
            if (typeof result === 'string' && !result.startsWith('http') && /^[a-z]/.test(result)) {
                log.warn(`Command output started with a lowercase "${result}".`);
            }

            // Output is silent
            if (result === Symbol.for('silent')) {
                return;
            }

            // Respond with command output
            await channel.send(result as string);
        } catch (error) {
            const appError = new AppError(error);
            await channel.send(appError.toEmbed());
        }
    }
};
