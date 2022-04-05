import {
  ConnectedVoltSDK,
  FriktionSDK,
  PendingDepositWithKey,
  VoltSDK,
} from '@friktion-labs/friktion-sdk'
import { AnchorWallet } from '@friktion-labs/friktion-sdk/dist/cjs/src/miscUtils'
import { WSOL_MINT } from '@components/instructions/tools'
import Decimal from 'decimal.js'
import { serializeInstructionToBase64 } from '@solana/spl-governance'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { WalletAdapter } from '@solana/wallet-adapter-base'
import {
  Account,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js'

import type { ConnectionContext } from 'utils/connection'
import { getATA } from '../../ataTools'
import { GovernedTokenAccount } from '../../tokens'
import { UiInstruction } from '../../uiTypes/proposalCreationTypes'
import { validateInstruction } from '@utils/instructionTools'
import BN from 'bn.js'

export async function getFriktionDepositInstruction({
  schema,
  form,
  amount,
  connection,
  wallet,
  setFormErrors,
}: {
  schema: any
  form: any
  amount: number
  programId: PublicKey | undefined
  connection: ConnectionContext
  wallet: WalletAdapter | undefined
  setFormErrors: any
}): Promise<UiInstruction> {
  const isValid = await validateInstruction({ schema, form, setFormErrors })
  let serializedInstruction = ''
  const prerequisiteInstructions: TransactionInstruction[] = []
  const governedTokenAccount = form.governedTokenAccount as GovernedTokenAccount
  const voltVaultId = new PublicKey(form.voltVaultId as string)

  const signers: Keypair[] = []
  if (
    isValid &&
    amount &&
    governedTokenAccount?.token?.publicKey &&
    governedTokenAccount?.token &&
    governedTokenAccount?.mint?.account &&
    governedTokenAccount?.governance &&
    wallet
  ) {
    const sdk = new FriktionSDK({
      provider: {
        connection: connection.current,
        wallet: (wallet as unknown) as AnchorWallet,
      },
    })
    const cVoltSDK = new ConnectedVoltSDK(
      connection.current,
      wallet.publicKey as PublicKey,
      await sdk.loadVoltByKey(voltVaultId),
      undefined,
      governedTokenAccount.governance.pubkey
    )

    const vaultMint = cVoltSDK.voltVault.vaultMint

    //we find true receiver address if its wallet and we need to create ATA the ata address will be the receiver
    const { currentAddress: receiverAddress, needToCreateAta } = await getATA({
      connection: connection,
      receiverAddress: governedTokenAccount.governance.pubkey,
      mintPK: vaultMint,
      wallet,
    })
    //we push this createATA instruction to transactions to create right before creating proposal
    //we don't want to create ata only when instruction is serialized
    if (needToCreateAta) {
      prerequisiteInstructions.push(
        Token.createAssociatedTokenAccountInstruction(
          ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
          TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
          vaultMint, // mint
          receiverAddress, // ata
          governedTokenAccount.governance.pubkey, // owner of token account
          wallet.publicKey! // fee payer
        )
      )
    }

    let depositTokenAccountKey: PublicKey | null

    if (governedTokenAccount.isSol) {
      const { currentAddress: receiverAddress, needToCreateAta } = await getATA(
        {
          connection: connection,
          receiverAddress: governedTokenAccount.governance.pubkey,
          mintPK: new PublicKey(WSOL_MINT),
          wallet,
        }
      )
      if (needToCreateAta) {
        prerequisiteInstructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
            TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
            new PublicKey(WSOL_MINT), // mint
            receiverAddress, // ata
            governedTokenAccount.governance.pubkey, // owner of token account
            wallet.publicKey! // fee payer
          )
        )
      }
      depositTokenAccountKey = receiverAddress
    } else {
      depositTokenAccountKey = governedTokenAccount.transferAddress!
    }

    try {
      let decimals = 9

      if (!governedTokenAccount.isSol) {
        const underlyingAssetMintInfo = await new Token(
          connection.current,
          governedTokenAccount.mint.publicKey,
          TOKEN_PROGRAM_ID,
          (null as unknown) as Account
        ).getMintInfo()
        decimals = underlyingAssetMintInfo.decimals
      }

      const depositIx = governedTokenAccount.isSol
        ? await cVoltSDK.depositWithClaim(
            new Decimal(amount),
            depositTokenAccountKey,
            receiverAddress,
            true,
            governedTokenAccount.transferAddress!,
            governedTokenAccount.governance.pubkey,
            decimals
          )
        : await cVoltSDK.depositWithClaim(
            new Decimal(amount),
            depositTokenAccountKey,
            receiverAddress,
            false,
            undefined,
            governedTokenAccount.governance.pubkey,
            decimals
          )

      if (governedTokenAccount.isSol) {
        const transferAddressIndex = depositIx.keys.findIndex(
          (k) =>
            k.pubkey.toString() ===
            governedTokenAccount.transferAddress?.toString()
        )
        depositIx.keys[transferAddressIndex].isSigner = true
        depositIx.keys[transferAddressIndex].isWritable = true
      }

      const governedAccountIndex = depositIx.keys.findIndex(
        (k) =>
          k.pubkey.toString() ===
          governedTokenAccount.governance?.pubkey.toString()
      )
      depositIx.keys[governedAccountIndex].isSigner = true

      serializedInstruction = serializeInstructionToBase64(depositIx)
    } catch (e) {
      if (e instanceof Error) {
        throw new Error('Error: ' + e.message)
      }
      throw e
    }
  }
  const obj: UiInstruction = {
    serializedInstruction,
    isValid,
    governance: governedTokenAccount?.governance,
    prerequisiteInstructions: prerequisiteInstructions,
    signers,
    shouldSplitIntoSeparateTxs: true,
  }
  return obj
}

export async function getFriktionWithdrawInstruction({
  schema,
  form,
  amount,
  connection,
  wallet,
  setFormErrors,
}: {
  schema: any
  form: any
  amount: number
  programId: PublicKey | undefined
  connection: ConnectionContext
  wallet: WalletAdapter | undefined
  setFormErrors: any
}): Promise<UiInstruction> {
  const isValid = await validateInstruction({ schema, form, setFormErrors })
  let serializedInstruction = ''
  const prerequisiteInstructions: TransactionInstruction[] = []
  const governedTokenAccount = form.governedTokenAccount as GovernedTokenAccount
  const voltVaultId = new PublicKey(form.voltVaultId as string)
  const depositTokenMint = new PublicKey(form.depositTokenMint as string)
  const signers: Keypair[] = []
  if (
    isValid &&
    amount &&
    governedTokenAccount?.token?.publicKey &&
    governedTokenAccount?.token &&
    governedTokenAccount?.mint?.account &&
    governedTokenAccount?.governance &&
    wallet
  ) {
    const sdk = new FriktionSDK({
      provider: {
        connection: connection.current,
        wallet: (wallet as unknown) as AnchorWallet,
      },
    })
    const cVoltSDK = new ConnectedVoltSDK(
      connection.current,
      wallet.publicKey as PublicKey,
      await sdk.loadVoltByKey(voltVaultId),
      undefined,
      governedTokenAccount.governance.pubkey
    )

    const vaultMint = cVoltSDK.voltVault.vaultMint

    try {
      let depositTokenDest: PublicKey | null

      if (governedTokenAccount.isSol) {
        const {
          currentAddress: receiverAddress,
          needToCreateAta,
        } = await getATA({
          connection: connection,
          receiverAddress: governedTokenAccount.governance.pubkey,
          mintPK: new PublicKey(WSOL_MINT),
          wallet,
        })
        if (needToCreateAta) {
          prerequisiteInstructions.push(
            Token.createAssociatedTokenAccountInstruction(
              ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
              TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
              new PublicKey(WSOL_MINT), // mint
              receiverAddress, // ata
              governedTokenAccount.governance.pubkey, // owner of token account
              wallet.publicKey! // fee payer
            )
          )
        }
        depositTokenDest = receiverAddress
      } else {
        depositTokenDest = governedTokenAccount.transferAddress!
      }

      //we find true receiver address if its wallet and we need to create ATA the ata address will be the receiver
      const { currentAddress: vaultTokenAccount } = await getATA({
        connection: connection,
        receiverAddress: governedTokenAccount.governance.pubkey,
        mintPK: vaultMint,
        wallet,
      })

      const withdrawIx = await cVoltSDK.withdrawHumanAmount(
        new BN(amount),
        depositTokenMint,
        vaultTokenAccount,
        null,
        depositTokenDest,
        governedTokenAccount.governance.pubkey
      )

      const governedAccountIndex = withdrawIx.keys.findIndex(
        (k) =>
          k.pubkey.toString() ===
          governedTokenAccount.governance?.pubkey.toString()
      )
      withdrawIx.keys[governedAccountIndex].isSigner = true

      serializedInstruction = serializeInstructionToBase64(withdrawIx)
    } catch (e) {
      if (e instanceof Error) {
        throw new Error('Error: ' + e.message)
      }
      throw e
    }
  }
  const obj: UiInstruction = {
    serializedInstruction,
    isValid,
    governance: governedTokenAccount?.governance,
    prerequisiteInstructions: prerequisiteInstructions,
    signers,
    shouldSplitIntoSeparateTxs: true,
  }
  return obj
}

export async function getFriktionClaimPendingDepositInstruction({
  schema,
  form,
  connection,
  wallet,
  setFormErrors,
}: {
  schema: any
  form: any
  programId: PublicKey | undefined
  connection: ConnectionContext
  wallet: WalletAdapter | undefined
  setFormErrors: any
}): Promise<UiInstruction> {
  const isValid = await validateInstruction({ schema, form, setFormErrors })
  let serializedInstruction = ''
  const prerequisiteInstructions: TransactionInstruction[] = []
  const governedTokenAccount = form.governedTokenAccount as GovernedTokenAccount
  const voltVaultId = new PublicKey(form.voltVaultId as string)
  const signers: Keypair[] = []
  if (
    isValid &&
    governedTokenAccount?.token?.publicKey &&
    governedTokenAccount?.token &&
    governedTokenAccount?.mint?.account &&
    governedTokenAccount?.governance &&
    wallet
  ) {
    const sdk = new FriktionSDK({
      provider: {
        connection: connection.current,
        wallet: (wallet as unknown) as AnchorWallet,
      },
    })
    const cVoltSDK = new ConnectedVoltSDK(
      connection.current,
      wallet.publicKey as PublicKey,
      await sdk.loadVoltByKey(voltVaultId),
      undefined,
      governedTokenAccount.governance.pubkey
    )

    const voltVault = cVoltSDK.voltVault
    const vaultMint = cVoltSDK.voltVault.vaultMint

    try {
      //we find true receiver address if its wallet and we need to create ATA the ata address will be the receiver
      const { currentAddress: receiverAddress, needToCreateAta } = await getATA(
        {
          connection: connection,
          receiverAddress: governedTokenAccount.governance.pubkey,
          mintPK: vaultMint,
          wallet,
        }
      )
      //we push this createATA instruction to transactions to create right before creating proposal
      //we don't want to create ata only when instruction is serialized
      if (needToCreateAta) {
        prerequisiteInstructions.push(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
            TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
            vaultMint, // mint
            receiverAddress, // ata
            governedTokenAccount.governance.pubkey, // owner of token account
            wallet.publicKey! // fee payer
          )
        )
      }

      const key = (
        await VoltSDK.findPendingDepositInfoAddress(
          voltVaultId,
          governedTokenAccount.governance.pubkey,
          cVoltSDK.sdk.programs.Volt.programId
        )
      )[0]
      const acct = await cVoltSDK.sdk.programs.Volt.account.pendingDeposit.fetch(
        key
      )
      const pendingDepositInfo = {
        ...acct,
        key: key,
      } as PendingDepositWithKey

      if (
        pendingDepositInfo &&
        pendingDepositInfo.roundNumber.lt(voltVault.roundNumber) &&
        pendingDepositInfo?.numUnderlyingDeposited?.gtn(0)
      ) {
        const ix = await cVoltSDK.claimPending(receiverAddress)
        serializedInstruction = serializeInstructionToBase64(ix)
      }
    } catch (e) {
      if (e instanceof Error) {
        throw new Error('Error: ' + e.message)
      }
      throw e
    }
  }
  const obj: UiInstruction = {
    serializedInstruction,
    isValid,
    governance: governedTokenAccount?.governance,
    prerequisiteInstructions: prerequisiteInstructions,
    signers,
    shouldSplitIntoSeparateTxs: true,
  }
  return obj
}

export async function getFriktionClaimPendingWithdrawInstruction({
  schema,
  form,
  connection,
  wallet,
  setFormErrors,
}: {
  schema: any
  form: any
  programId: PublicKey | undefined
  connection: ConnectionContext
  wallet: WalletAdapter | undefined
  setFormErrors: any
}): Promise<UiInstruction> {
  const isValid = await validateInstruction({ schema, form, setFormErrors })
  let serializedInstruction = ''
  const prerequisiteInstructions: TransactionInstruction[] = []
  const governedTokenAccount = form.governedTokenAccount as GovernedTokenAccount
  const voltVaultId = new PublicKey(form.voltVaultId as string)
  const signers: Keypair[] = []
  if (
    isValid &&
    governedTokenAccount?.token?.publicKey &&
    governedTokenAccount?.token &&
    governedTokenAccount?.mint?.account &&
    governedTokenAccount?.governance &&
    wallet
  ) {
    const sdk = new FriktionSDK({
      provider: {
        connection: connection.current,
        wallet: (wallet as unknown) as AnchorWallet,
      },
    })
    const cVoltSDK = new ConnectedVoltSDK(
      connection.current,
      wallet.publicKey as PublicKey,
      await sdk.loadVoltByKey(voltVaultId),
      undefined,
      governedTokenAccount.governance.pubkey
    )

    const voltVault = cVoltSDK.voltVault

    try {
      let depositTokenDest: PublicKey | null

      if (governedTokenAccount.isSol) {
        const {
          currentAddress: receiverAddress,
          needToCreateAta,
        } = await getATA({
          connection: connection,
          receiverAddress: governedTokenAccount.governance.pubkey,
          mintPK: new PublicKey(WSOL_MINT),
          wallet,
        })
        if (needToCreateAta) {
          prerequisiteInstructions.push(
            Token.createAssociatedTokenAccountInstruction(
              ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
              TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
              new PublicKey(WSOL_MINT), // mint
              receiverAddress, // ata
              governedTokenAccount.governance.pubkey, // owner of token account
              wallet.publicKey! // fee payer
            )
          )
        }
        depositTokenDest = receiverAddress
      } else {
        depositTokenDest = governedTokenAccount.transferAddress!
      }

      const key = (
        await VoltSDK.findPendingWithdrawalInfoAddress(
          voltVaultId,
          governedTokenAccount.governance.pubkey,
          cVoltSDK.sdk.programs.Volt.programId
        )
      )[0]
      const acct = await this.sdk.programs.Volt.account.pendingWithdrawal.fetch(
        key
      )
      const pendingWithdrawalInfo = {
        ...acct,
        key: key,
      }

      if (
        pendingWithdrawalInfo &&
        pendingWithdrawalInfo.roundNumber.lt(voltVault.roundNumber) &&
        pendingWithdrawalInfo?.numVoltRedeemed?.gtn(0)
      ) {
        const ix = await cVoltSDK.claimPendingWithdrawal(depositTokenDest)
        serializedInstruction = serializeInstructionToBase64(ix)
      }
    } catch (e) {
      if (e instanceof Error) {
        throw new Error('Error: ' + e.message)
      }
      throw e
    }
  }
  const obj: UiInstruction = {
    serializedInstruction,
    isValid,
    governance: governedTokenAccount?.governance,
    prerequisiteInstructions: prerequisiteInstructions,
    signers,
    shouldSplitIntoSeparateTxs: true,
  }
  return obj
}
