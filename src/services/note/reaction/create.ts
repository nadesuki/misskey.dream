import { IUser, pack as packUser, isLocalUser, isRemoteUser } from '../../../models/user';
import Note, { INote, pack as packNote } from '../../../models/note';
import NoteReaction from '../../../models/note-reaction';
import { publishNoteStream } from '../../../publishers/stream';
import notify from '../../../publishers/notify';
import pushSw from '../../../publishers/push-sw';
import NoteWatching from '../../../models/note-watching';
import watch from '../watch';
import renderLike from '../../../remote/activitypub/renderer/like';
import { deliver } from '../../../queue';
import context from '../../../remote/activitypub/renderer/context';

export default async (user: IUser, note: INote, reaction: string) => new Promise(async (res, rej) => {
	// Myself
	if (note.userId.equals(user._id)) {
		return rej('cannot react to my note');
	}

	// if already reacted
	const exist = await NoteReaction.findOne({
		noteId: note._id,
		userId: user._id
	});

	if (exist !== null) {
		return rej('already reacted');
	}

	// Create reaction
	await NoteReaction.insert({
		createdAt: new Date(),
		noteId: note._id,
		userId: user._id,
		reaction
	});

	res();

	const inc = {};
	inc[`reactionCounts.${reaction}`] = 1;

	// Increment reactions count
	await Note.update({ _id: note._id }, {
		$inc: inc
	});

	publishNoteStream(note._id, 'reacted');

	// Notify
	notify(note.userId, user._id, 'reaction', {
		noteId: note._id,
		reaction: reaction
	});

	pushSw(note.userId, 'reaction', {
		user: await packUser(user, note.userId),
		note: await packNote(note, note.userId),
		reaction: reaction
	});

	// Fetch watchers
	NoteWatching
		.find({
			noteId: note._id,
			userId: { $ne: user._id }
		}, {
			fields: {
				userId: true
			}
		})
		.then(watchers => {
			watchers.forEach(watcher => {
				notify(watcher.userId, user._id, 'reaction', {
					noteId: note._id,
					reaction: reaction
				});
			});
		});

	// ユーザーがローカルユーザーかつ自動ウォッチ設定がオンならばこの投稿をWatchする
	if (isLocalUser(user) && user.settings.autoWatch !== false) {
		watch(user._id, note);
	}

	//#region 配信
	const content = renderLike(user, note);
	content['@context'] = context;

	// リアクターがローカルユーザーかつリアクション対象がリモートユーザーの投稿なら配送
	if (isLocalUser(user) && isRemoteUser(note._user)) {
		deliver(user, content, note._user.inbox).save();
	}
	//#endregion
});
