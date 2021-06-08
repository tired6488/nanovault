import { Component, OnInit } from '@angular/core';
import BigNumber from "bignumber.js";
import {AddressBookService} from "../../services/address-book.service";
import {BehaviorSubject} from "rxjs/BehaviorSubject";
import {WalletService} from "../../services/wallet.service";
import {NotificationService} from "../../services/notification.service";
import {ApiService} from "../../services/api.service";
import {UtilService} from "../../services/util.service";

import * as blake from 'blakejs';
import {WorkPoolService} from "../../services/work-pool.service";
import {AppSettingsService} from "../../services/app-settings.service";
import {ActivatedRoute, ActivatedRouteSnapshot} from "@angular/router";
import {PriceService} from "../../services/price.service";
import {TrollarBlockService} from "../../services/trollar-block.service";

const nacl = window['nacl'];

@Component({
  selector: 'app-send',
  templateUrl: './send.component.html',
  styleUrls: ['./send.component.css']
})
export class SendComponent implements OnInit {
  trollar = 1000000000000000000000000;

  activePanel = 'send';

  accounts = this.walletService.wallet.accounts;
  addressBookResults$ = new BehaviorSubject([]);
  showAddressBook = false;
  addressBookMatch = '';

  amounts = [
    { name: 'NANO (1 Mtrollar)', shortName: 'NANO', value: 'mtrollar' },
    { name: 'ktrollar (0.001 Mtrollar)', shortName: 'ktrollar', value: 'ktrollar' },
    { name: 'trollar (0.000001 Mtrollar)', shortName: 'trollar', value: 'trollar' },
  ];
  selectedAmount = this.amounts[0];

  amount = null;
  amountRaw = new BigNumber(0);
  amountFiat: number|null = null;
  rawAmount: BigNumber = new BigNumber(0);
  fromAccount: any = {};
  fromAccountID: any = '';
  fromAddressBook = '';
  toAccount: any = false;
  toAccountID: string = '';
  toAddressBook = '';
  toAccountStatus = null;
  confirmingTransaction: boolean = false;

  constructor(
    private router: ActivatedRoute,
    private walletService: WalletService,
    private addressBookService: AddressBookService,
    private notificationService: NotificationService,
    private nodeApi: ApiService,
    private trollarBlock: TrollarBlockService,
    public price: PriceService,
    private workPool: WorkPoolService,
    public settings: AppSettingsService,
    private util: UtilService) { }

  async ngOnInit() {
    const params = this.router.snapshot.queryParams;
    if (params && params.amount) {
      this.amount = params.amount;
    }
    if (params && params.to) {
      this.toAccountID = params.to;
      this.validateDestination();
    }

    this.addressBookService.loadAddressBook();

    // Set default From account
    this.fromAccountID = this.accounts.length ? this.accounts[0].id : '';

    // We want to look for the first account in the wallet that has a balance

    // If the wallet balance is zero, this might be an initial load to the send page
    // If it is, we want to load balances before we try to find the right account
    if (this.walletService.wallet.balance.isZero()) {
      await this.walletService.reloadBalances();
    }

    // Look for the first account that has a balance
    const accountIDWithBalance = this.accounts.reduce((previous, current) => {
      if (previous) return previous;
      if (current.balance.gt(0)) return current.id;
      return null;
    }, null);

    if (accountIDWithBalance) {
      this.fromAccountID = accountIDWithBalance;
    }
  }

  // An update to the Trollar amount, sync the fiat value
  syncFiatPrice() {
    const rawAmount = this.getAmountBaseValue(this.amount || 0).plus(this.amountRaw);
    if (rawAmount.lte(0)) {
      this.amountFiat = 0;
      return;
    }

    // This is getting hacky, but if their currency is bitcoin, use 6 decimals, if it is not, use 2
    const precision = this.settings.settings.displayCurrency === 'BTC' ? 1000000 : 100;

    // Determine fiat value of the amount
    const fiatAmount = this.util.trollar.rawToMtrollar(rawAmount).times(this.price.price.lastPrice).times(precision).floor().div(precision).toNumber();
    this.amountFiat = fiatAmount;
  }

  // An update to the fiat amount, sync the trollar value based on currently selected denomination
  syncTrollarPrice() {
    const fiatAmount = this.amountFiat || 0;
    const rawAmount = this.util.trollar.mtrollarToRaw(new BigNumber(fiatAmount).div(this.price.price.lastPrice));
    const trollarVal = this.util.trollar.rawToTrollar(rawAmount).floor();
    const trollarAmount = this.getAmountValueFromBase(this.util.trollar.trollarToRaw(trollarVal));

    this.amount = trollarAmount.toNumber();
  }

  searchAddressBook() {
    this.showAddressBook = true;
    const search = this.toAccountID || '';
    const addressBook = this.addressBookService.addressBook;

    const matches = addressBook
      .filter(a => a.name.toLowerCase().indexOf(search.toLowerCase()) !== -1)
      .slice(0, 5);

    this.addressBookResults$.next(matches);
  }

  selectBookEntry(account) {
    this.showAddressBook = false;
    this.toAccountID = account;
    this.searchAddressBook();
    this.validateDestination();
  }

  async validateDestination() {
    // The timeout is used to solve a bug where the results get hidden too fast and the click is never registered
    setTimeout(() => this.showAddressBook = false, 400);

    // Remove spaces from the account id
    this.toAccountID = this.toAccountID.replace(/ /g, '');

    this.addressBookMatch = this.addressBookService.getAccountName(this.toAccountID);

    // const accountInfo = await this.walletService.walletApi.accountInfo(this.toAccountID);
    const accountInfo = await this.nodeApi.accountInfo(this.toAccountID);
    if (accountInfo.error) {
      if (accountInfo.error == 'Account not found') {
        this.toAccountStatus = 1;
      } else {
        this.toAccountStatus = 0;
      }
    }
    if (accountInfo && accountInfo.frontier) {
      this.toAccountStatus = 2;
    }
  }

  async sendTransaction() {
    const isValid = await this.nodeApi.validateAccountNumber(this.toAccountID);
    if (!isValid || isValid.valid == '0') return this.notificationService.sendWarning(`To account address is not valid`);
    if (!this.fromAccountID || !this.toAccountID) return this.notificationService.sendWarning(`From and to account are required`);

    const from = await this.nodeApi.accountInfo(this.fromAccountID);
    const to = await this.nodeApi.accountInfo(this.toAccountID);
    if (!from) return this.notificationService.sendError(`From account not found`);

    from.balanceBN = new BigNumber(from.balance || 0);
    to.balanceBN = new BigNumber(to.balance || 0);

    this.fromAccount = from;
    this.toAccount = to;

    const rawAmount = this.getAmountBaseValue(this.amount || 0);
    this.rawAmount = rawAmount.plus(this.amountRaw);

    const trollarAmount = this.rawAmount.div(this.trollar);

    if (this.amount < 0 || rawAmount.lessThan(0)) return this.notificationService.sendWarning(`Amount is invalid`);
    if (trollarAmount.lessThan(1)) return this.notificationService.sendWarning(`Transactions for less than 1 trollar will be ignored by the node.  Send raw amounts with at least 1 trollar.`);
    if (from.balanceBN.minus(rawAmount).lessThan(0)) return this.notificationService.sendError(`From account does not have enough NANO`);

    // Determine a proper raw amount to show in the UI, if a decimal was entered
    this.amountRaw = this.rawAmount.mod(this.trollar);

    // Determine fiat value of the amount
    this.amountFiat = this.util.trollar.rawToMtrollar(rawAmount).times(this.price.price.lastPrice).toNumber();

    // Start precopmuting the work...
    this.fromAddressBook = this.addressBookService.getAccountName(this.fromAccountID);
    this.toAddressBook = this.addressBookService.getAccountName(this.toAccountID);
    this.workPool.addWorkToCache(this.fromAccount.frontier);

    this.activePanel = 'confirm';
  }

  async confirmTransaction() {
    const walletAccount = this.walletService.wallet.accounts.find(a => a.id == this.fromAccountID);
    if (!walletAccount) throw new Error(`Unable to find sending account in wallet`);
    if (this.walletService.walletIsLocked()) return this.notificationService.sendWarning(`Wallet must be unlocked`);

    this.confirmingTransaction = true;

    try {
      // New stuff to show status of each part of the transaction.
      // console.log('Sending sub send command....');
      // this.trollarBlock.subscribeSend(walletAccount, this.toAccountID, this.rawAmount, this.walletService.isLedgerWallet()).subscribe(value => {
      //   console.log('GOT VALUE!!! ', value)
      // }, err => {
      //   console.log('GOT ERROR!!!: ', err);
      // });
      const newHash = await this.trollarBlock.generateSend(walletAccount, this.toAccountID, this.rawAmount, this.walletService.isLedgerWallet());
      if (newHash) {
        this.notificationService.sendSuccess(`Successfully sent ${this.amount} ${this.selectedAmount.shortName}!`);
        this.activePanel = 'send';
        this.amount = null;
        this.amountFiat = null;
        this.resetRaw();
        this.toAccountID = '';
        this.toAccountStatus = null;
        this.fromAddressBook = '';
        this.toAddressBook = '';
        this.addressBookMatch = '';
      } else {
        if (!this.walletService.isLedgerWallet()) {
          this.notificationService.sendError(`There was an error sending your transaction, please try again.`)
        }
      }
    } catch (err) {
      this.notificationService.sendError(`There was an error sending your transaction: ${err.message}`)
    }


    this.confirmingTransaction = false;

    await this.walletService.reloadBalances();
  }

  setMaxAmount() {
    const walletAccount = this.walletService.wallet.accounts.find(a => a.id === this.fromAccountID);
    if (!walletAccount) return;

    this.amountRaw = walletAccount.balanceRaw;

    const trollarVal = this.util.trollar.rawToTrollar(walletAccount.balance).floor();
    const maxAmount = this.getAmountValueFromBase(this.util.trollar.trollarToRaw(trollarVal));
    this.amount = maxAmount.toNumber();
    this.syncFiatPrice();
  }

  resetRaw() {
    this.amountRaw = new BigNumber(0);
  }

  getAmountBaseValue(value) {

    switch (this.selectedAmount.value) {
      default:
      case 'trollar': return this.util.trollar.trollarToRaw(value);
      case 'ktrollar': return this.util.trollar.ktrollarToRaw(value);
      case 'mtrollar': return this.util.trollar.mtrollarToRaw(value);
    }
  }

  getAmountValueFromBase(value) {
    switch (this.selectedAmount.value) {
      default:
      case 'trollar': return this.util.trollar.rawToTrollar(value);
      case 'ktrollar': return this.util.trollar.rawToKtrollar(value);
      case 'mtrollar': return this.util.trollar.rawToMtrollar(value);
    }
  }

}
